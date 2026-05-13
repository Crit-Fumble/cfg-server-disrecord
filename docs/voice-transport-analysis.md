# Voice transport architecture — analysis for Thursday review

**Status**: open question. Affects how the gateway and worker split responsibilities.
Writing this up so we can settle it before building the gateway core.

## The constraint

Discord enforces **one voice connection per bot identity per guild** — but the
bot CAN be in many guilds simultaneously, each with its own voice channel.
Confirmed by Hob 2026-05-13: "I want multiple discord guilds/servers to be able
to use the bot at the same time from different servers. If each user is using
their own Recording Server, this should work."

So the architectural shape that needs to hold:

- One Discord gateway connection (held by the always-on gateway-router)
- Many concurrent voice channel joins, one per active Recording Server, each
  in a different guild
- Per-installation worker containers, each handling one guild's recording
- Worker talks to core-server directly for transcripts + billing; gateway
  brokers Discord events to its worker

What this rules out: a worker can't open its OWN voice WSS as the same bot
identity (the voice session is tied to the gateway's gateway connection).
Workers must consume voice events from the gateway.

## What this rules out

The clean Craig.chat-style pattern I originally sketched in `docs/ARCHITECTURE.md`
assumed:

```
Gateway container          Worker container
  └─ Discord gateway        └─ Discord voice WSS (its own connection)
                            └─ Opus decode → Deepgram
```

This doesn't work because the worker can't open its own voice WSS — only the
gateway holds the credentials Discord will accept. We tried to paper over this
with seed-from-env (`seedVoiceServerUpdate` / `seedVoiceStateUpdate` in
`src/worker/gateway-bridge.ts`) but the tokens go stale immediately on Discord's
side once the gateway's voice connection terminates.

## Three viable paths

### Option A — Gateway does voice + opus decode, worker does Deepgram

```
Gateway container                              Worker container
  └─ Discord gateway                              └─ Receives PCM via SSE
  └─ Voice connection (one per guild)             └─ Per-speaker Deepgram WS
  └─ Subscribes to speakers, decodes opus → PCM   └─ Emits transcripts to core-server
  └─ SSE: pushes (speakerId, pcmFrame) to worker
```

- **Pros**: aligns with Discord's protocol; worker is light (just Deepgram); per-
  worker billing maps cleanly to per-user Deepgram costs.
- **Cons**: gateway is heavy (opus decode runs there); the "container per session"
  framing weakens — sessions still get their own worker, but the gateway is shared
  CFG infra carrying audio bandwidth for all of them.
- **CPU split**: opus decode ~3-5% CPU per active speaker. With ~20 simultaneous
  speakers worst case, gateway runs at ~60-100% of one core. Manageable on a
  dedicated 2-vCPU instance.

### Option B — Gateway does voice, worker does opus + Deepgram

```
Gateway container                              Worker container
  └─ Discord gateway                              └─ Receives opus via SSE
  └─ Voice connection (one per guild)             └─ Opus decode (CPU here)
  └─ Subscribes to speakers, forwards opus → SSE  └─ Per-speaker Deepgram WS
                                                  └─ Emits transcripts to core-server
```

- **Pros**: gateway stays light; opus decode CPU is per-worker (scales with user
  growth, not platform); worker has more compute attached to the user's CT pool.
- **Cons**: SSE bandwidth higher (opus is compressed but still meaningful at scale);
  more bytes flowing per session.
- **Bandwidth**: ~96 kbps per speaker × N speakers × M sessions. At 9 Alpha users
  with maybe 4 simultaneous sessions × 4 speakers = ~1.5 Mbps. Negligible on
  loopback / internal VPC.

### Option C — Single multi-tenant container (one bot, in-process recording)

```
ReSesh container (only one platform-wide)
  └─ Discord gateway
  └─ Voice connections to N channels across N guilds
  └─ Per-channel RecordingSession instances
  └─ Per-speaker Deepgram WS
  └─ Per-installation CT billing emission
```

- **Pros**: simplest; matches existing cfg-core-server's in-process recording today;
  no cross-process plumbing.
- **Cons**: violates "each installation in a separate container" (HUMAN-NOTES);
  no per-installation isolation; CT billing per installation requires careful
  attribution inside one process.

## Recommendation

**Start with Option B**, fall back to **Option A** if SSE bandwidth becomes a
problem at scale.

Reasoning:
- Option B keeps the gateway light, which matters for the always-on container's
  resource ceiling (we want gateway to be a small-tier container).
- Opus is already designed for streaming and compresses well; the bandwidth
  overhead is real but bounded.
- Worker decode CPU correctly scales with active sessions and bills against the
  user.
- The codebase we have right now (gateway-bridge + voice-receiver + RecordingSession)
  is closest to Option A/B and farthest from Option C — we get to keep most of
  what's built either way.

## What changes in the codebase

For Option B:
- **Gateway**: replace the in-place stubs in `src/gateway.ts` with:
  - `joinVoiceChannel` on gateway's own Client when POST /v1/sessions arrives
  - Receiver.subscribe per speaker → push opus frames to SSE channel keyed on
    `(installationId, speakerId)`
  - Spawn worker container with env including the SSE URL
- **Worker**: replace `voice-receiver.ts` with an SSE consumer that:
  - Subscribes to the gateway's `/internal/sessions/:id/audio` stream
  - Decodes opus → PCM (existing decoder code lifts cleanly)
  - Calls `RecordingSession.onSpeakerStart/Data/End` (unchanged)
- **gateway-bridge.ts**: deletable; cross-process @discordjs/voice adapter is
  unnecessary because workers don't have their own voice connections.

What stays:
- `RecordingSession` — clean separation paid off; no changes
- Deepgram client — no changes
- ReSesh adapter in cfg-core-server — HTTP shape unchanged
- Server Manager kind-registry — unchanged

## Decision needed

Confirm Option B (or pick another). Once locked, ~1 day of gateway-side work
to flesh out the voice→SSE forwarder; worker side simplifies (no custom
adapter).

Suggest reviewing Thursday morning before continuing on the gateway core.
