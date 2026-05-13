# cfg-server-disrecord Architecture

## Two-mode binary

Single TS codebase, two run modes. The mode is the first CLI arg.

| Mode | Lifetime | Discord connection | HTTP API | Bills |
|---|---|---|---|---|
| `gateway` | Always-on (until cluster shut down) | Gateway WSS (1× per bot identity) | Yes — for core-server | Container uptime |
| `worker` | Per session | Voice WSS only (joins specific channel) | No (gateway owns it) | Container uptime + optional transcription |

The single-binary choice is for shipping speed. If the gateway grows enough
internal state that the worker shouldn't carry it, split later.

## Why gateway-router

Discord enforces **one gateway session per bot identity**. We have one
identity (client_id 1504164101553656028) and need to support multiple
concurrent recording sessions across parties. Options:

1. **Single multi-tenant container** — one process handles all sessions. Simple
   but doesn't fit "each instance in a separate container" requirement.
2. **Per-installation bot identities** — each user provisions their own Discord
   app. Heavy lift for users, ugly UX (different bot names per party).
3. ✅ **Gateway-router + worker containers** — one identity, one gateway, but
   voice connections are per-channel and can be done from separate processes.
   Per-session worker containers join the voice channel using `session_id` +
   `token` from the gateway's `VOICE_SERVER_UPDATE` event.

## Worker spawning

When the gateway receives a "start recording" trigger (slash command, scheduled
event auto-start, or core-server API call):

1. Gateway joins the target voice channel (via `discord.js` voice manager)
2. Captures `VOICE_SERVER_UPDATE` token + `VOICE_STATE_UPDATE` session_id
3. Calls core-server's billing endpoint to confirm CT availability
4. Spawns a worker container (via `dockerode` on the host) with env:
   - `DISRECORD_VOICE_TOKEN`, `DISRECORD_VOICE_SESSION_ID`, `DISRECORD_VOICE_ENDPOINT`
   - `DISRECORD_GUILD_ID`, `DISRECORD_CHANNEL_ID`, `DISRECORD_USER_ID`, `DISRECORD_INSTALLATION_ID`
   - `DISRECORD_DEEPGRAM_MODE`: `platform` | `byok` | `disabled`
   - `DISRECORD_DEEPGRAM_KEY`: present only when mode=`byok` (encrypted by core-server, decrypted here)
5. Worker connects directly to Discord voice WSS using the handed-off tokens
6. Worker records, streams to Deepgram, persists transcript via core-server API
7. On session end (or worker exit), gateway emits final billing tick

## Failure modes

- **Worker crash mid-session**: gateway detects exit, marks session failed,
  charges final partial uptime, emits Discord channel message to notify the host.
- **Gateway restart**: in-flight worker containers keep recording (voice WSS is
  worker-owned). On gateway boot, it reconciles running containers via Docker
  API and resumes session tracking.
- **Deepgram WS drop**: worker reconnects (the keepalive-fix from
  cfg-core-server#63 — DO NOT idle-close the stream).

## Out of scope for v0.1

- Multi-region worker placement (workers run on the same host as gateway)
- Cross-cluster gateway sharding (we have one cluster)
- RTMP ingest (Phase 1+ — see cfg-core-server#69)
- LiveKit fallback (cfg-core-server#54)
