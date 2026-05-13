# Gateway core — infra design

Companion to `voice-transport-analysis.md`. Locks the request/data flow so we
agree before implementing.

## Goal

Discord recording works for many simultaneous users (one per guild) WITHOUT
core-server becoming a bottleneck. The bot (gateway) and the recording
server (worker) talk directly on the audio + control hot paths; core-server
is involved only for persistence, billing, and policy.

## Process topology

### Phase 0 (this week)

All on the core droplet, sharing the existing private VPC interface.

```
core droplet
├─ core-server (Fastify) — port 3001
├─ core-browser (Next.js)  — port 3000
├─ cfg-resesh-gateway      — port 4400  (always on, ONE per cluster)
└─ cfg-resesh-worker-*     — port 4401+ (ephemeral, one per active session)
```

### Phase A (cfg-core-dev-tools#23, already on the board)

Move gateway + workers to a dedicated `cfg-voice` droplet behind the same
VPC so audio bandwidth doesn't compete with the API/web tier.

```
core droplet                      cfg-voice droplet
├─ core-server                    ├─ cfg-resesh-gateway
└─ core-browser                   └─ cfg-resesh-worker-*
        │                                  │
        └──────── VPC private ─────────────┘
```

No code change between Phase 0 and Phase A — same internal endpoints, just
crossing a VPC hop instead of localhost.

## Identity + auth

Three trust boundaries:

| From → To | Mechanism | Why |
|---|---|---|
| browser → core-server | Auth.js v5 session JWT (existing) | User identity. Same as today. |
| core-server → gateway | Shared secret bearer (`RESESH_AUTH_SECRET`) | Platform → platform. Both rotate via DO secret manager. |
| gateway ↔ worker | Same shared secret + per-session token | Per-session token bound to (installationId, sessionId). Worker accepts SSE only from gateway. |
| worker → core-server | Same `RESESH_AUTH_SECRET` + an explicit `installationId` claim | Worker can ONLY write to its own installation's transcripts + billing. core-server enforces. |

Workers do NOT speak to the browser. Anything the user sees about an
in-flight recording comes through core-server (proxy pattern for views).

## Hot, warm, cold, billing paths

The data-flow split that keeps core-server out of the bottleneck:

| Path | Frequency | Goes through core-server? | Bandwidth |
|---|---|---|---|
| **HOT — Opus audio frames** | Per 20 ms while a speaker is active. ~50/sec/speaker. | **No.** Gateway → worker SSE over private network. | High (~96 kbps/speaker compressed) |
| **WARM — Finalized transcripts** | Per utterance. ~1–5 per minute per active speaker. | Yes. Worker POSTs to core-server `/api/v1/recording/transcripts`. | Trivial (text only) |
| **COLD — Session lifecycle** | Once at start, once at stop. Per session. | Yes — but rare. core-server → gateway POST `/v1/sessions`. | Trivial |
| **BILLING — CT uptime tick** | Every 15 min while active. | Yes. Worker POSTs to core-server `/api/v1/billing/uptime-tick`. | Trivial |

Even with 9 concurrent sessions × 5 speakers each = 45 simultaneous opus
streams, core-server sees only ~225 transcript POSTs/minute (well under its
existing campaign-traffic baseline). The 4.3 Mbps of audio flows
gateway ↔ workers directly.

## Single-channel-per-guild enforcement

The Discord constraint is per-bot-per-guild. We enforce in the gateway:

1. Gateway maintains an in-memory `activeSessionsByGuild: Map<guildId, sessionId>`
2. Persisted to Redis (Phase 1) or a Prisma row (Phase 0) so restarts don't drop state
3. On POST `/v1/sessions`:
   - If `activeSessionsByGuild.has(guildId)` → return **409 Conflict** with the
     conflicting `sessionId` and a hint message
   - Else: provision → set the map entry → return 201
4. On worker exit (graceful or crash): clear the map entry

The ReSesh adapter surfaces the 409 as a typed error (`ReseshGatewayConflict`)
so the UI can render the right message: "Another Recording Server is active
in this Discord server — stop it or wait for it to finish."

This is consistent with how every other Discord bot in the ecosystem behaves
(Craig, Carl, Dyno-with-voice): one voice connection per guild per bot identity.

## Proxy vs direct — the platform pattern

Hob's framing — "protect with auth and enhance certain views with proxy;
when we can securely skip the proxy and have the bot talk directly, that
is ideal" — generalizes to all hosted servers, not just ReSesh:

| Use case | Path | Why |
|---|---|---|
| User views their Recording Server status in the browser | browser → core-server → gateway → worker | Auth enforced at core; gateway / worker is a private service. |
| User downloads a transcript MP3 | browser → core-server → spaces | core-server proxies the signed-URL fetch; auth at core. |
| Worker streams a transcript to core for persistence | worker → core-server | Worker is trusted via shared secret; core writes DB row. |
| Worker pulls Deepgram | worker → Deepgram | Hot path; never touches core. |
| Gateway dispatches opus frames to its worker | gateway → worker | Hot path; never touches core. |

The pattern: **proxy when a browser is involved or auth must be enforced;
direct when both endpoints are platform-trusted services.**

## What the gateway core implements

Concrete endpoints, in the order needed:

1. `POST /v1/sessions` — auth check → guild conflict check → join voice
   channel → capture handoff → spawn worker container → return 201
2. `DELETE /v1/sessions/:installationId` — find session → SIGTERM worker
   → emit final billing tick → leave voice → return 204
3. `GET /v1/sessions/:installationId/status` — return health snapshot
4. `GET /internal/sessions/:installationId/audio` — SSE stream of opus
   frames keyed on `(installationId, speakerId)`. Auth via the per-session
   token issued at spawn time. **Workers ONLY** call this.
5. `POST /internal/voice/payload` — receives sendPayload calls from the
   worker's @discordjs/voice adapter (kept for protocol completeness even
   in Option B; lets worker reply to RTP probes if needed)
6. `GET /health` — readiness probe (Discord ready? active sessions count?)

## Worker → core-server endpoints

These exist on **core-server** (added Thursday alongside the gateway core):

1. `POST /api/v1/recording/transcripts` — body: `{ installationId, speakerId,
   transcript, startSec, endSec, words?, isRedacted }`. Auth: shared
   secret. Effect: persist via Prisma; emit voiceCaptionEvents SSE for
   the live caption stream.
2. `POST /api/v1/billing/uptime-tick` — body: `{ installationId, kind,
   resourceType, minutes, ctPerMinute, label }`. Auth: shared secret.
   Effect: `chargeContainerUptime` (existing function).
3. `GET /api/v1/recording/session-policy/:installationId` — returns
   `{ consentedUserIds: string[], speakerNames: Record<userId, displayName> }`.
   Worker calls on session start so it doesn't reinvent the consent set.

All three already have existing-shape parallels in core-server — straight
port to a thin internal-auth wrapper.

## Decision points still open

- **Worker port allocation**: dynamic per spawn (`4401`, `4402`, …) or
  fixed-and-recycle? Dynamic is simpler; fixed lets ops dashboards know
  what to point at. **Suggest dynamic, exposed via Docker's port mapping.**
- **Worker base image registry**: same DO registry as cfg-core-server, or
  separate? **Suggest same — `registry.digitalocean.com/crit-fumble/cfg-resesh:latest`.**
- **Worker isolation**: own user namespace? Read-only filesystem except
  for the transcript scratch dir? **Suggest read-only root + tmpfs scratch.**
- **Session-state durability across gateway restarts**: in-memory map +
  Redis Phase 1, or Prisma row from day one? **Suggest Prisma — we already
  have it, no new infra dep.**
