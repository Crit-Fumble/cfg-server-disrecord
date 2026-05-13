# cfg-resesh — Crit-Fumble Recording Server

Discord voice recording + live transcription as a user-provisionable server.

## What it is

A standalone Discord bot + service that records voice channels and routes audio
to Deepgram for live transcription. Provisioned through Crit-Fumble's Server
Manager and billed against the user's Crit-Coins (CT) pool.

- **Discord app**: client_id `1504164101553656028`
- **License**: AGPL-3.0-only
- **Sizing**: even the smallest instance must support a 12-hour continuous recording session

## Architecture: gateway-router + worker containers

Inspired by Craig.chat. One always-on gateway-router holds the single Discord
gateway connection. When a user provisions a Recording Server, the gateway-
router spawns a worker container that connects to Discord's voice WSS and does
the actual recording. The worker exits when the session ends.

```
┌──────────────────────────────┐         ┌────────────────────────┐
│ cfg-resesh gateway-router    │         │ Worker container       │
│ (always-on, 1× per cluster)  │ spawn → │ (per recording session)│
│                              │         │                        │
│ • Discord gateway WSS        │         │ • Discord voice WSS    │
│ • Receives VOICE_STATE_UPDATE│         │ • Opus → PCM           │
│ • Slash-command handler      │         │ • PCM → Deepgram WS    │
│ • HTTP API for core-server   │         │ • Persist transcript   │
└──────────────────────────────┘         └────────────────────────┘
```

## Modes

Single binary, two run modes selected by CMD arg:

```sh
node dist/index.js gateway    # the always-on gateway-router
node dist/index.js worker     # a per-session recording worker
```

## Charge model

Per the platform's CT economy:

- **Bot uptime**: CT/min by instance size. Recording itself is included.
- **Live Transcription** (optional):
  - **(A) Platform Deepgram key** → user pays extra CT for transcription minutes
  - **(B) BYO Deepgram key** → no transcription surcharge

## Status

Phase 0 scaffold. Not yet deployed. Tracking: cfg-core-dev-tools#117 (epic).

## Development

```sh
npm install
npm run dev:gateway    # local dev with file-watching
npm test
```

Pre-push hook runs the full test suite (cfg-* convention). No `--no-verify` —
fix the test instead.
