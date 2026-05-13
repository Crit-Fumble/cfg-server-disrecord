# cfg-server-disrecord — DisRecord worker container

The per-session worker container for the DisRecord backend kind: connects
to the audio SSE stream that cfg-core-server publishes for an active
recording, decodes opus, runs per-speaker Deepgram, and POSTs transcripts
+ billing ticks back to core-server.

- **Image**: `cfg-server-disrecord:local` (dev) / registry path (prod)
- **License**: AGPL-3.0-only
- **Discord app**: `1504164101553656028` (ReSesh — owned by cfg-core-server's
  in-process gateway, not this container)

## Where the orchestration lives

The always-on Discord WebSocket + voice-channel join + opus → SSE fan-out
all live inside **cfg-core-server** under `services/disrecord/`. This repo
contains only the per-session container that runs inside Docker once
core-server has accepted a recording.

Earlier revisions of this repo shipped a separate `gateway` Fastify service;
that got merged into core-server when the cross-service HTTP-bridge proved
to be more complexity than the per-kind isolation was worth. See
core-server's `services/disrecord/index.ts` for the orchestration entry
point.

## Auth

The worker holds zero long-lived credentials.

`CORE_SERVER_TOKEN` is a per-session JWT minted by core-server at session
start. It carries `scope='disrecord-worker'` + an `installationId` claim
(= the `RecordingSession.id` for this session) and a short expiry. Same
token gates:

- The SSE opus subscription: `GET ${CORE_SERVER_URL}/api/internal/disrecord/sessions/:installationId/audio`
- The callback POSTs: `POST /api/v1/recording/transcripts`, `POST /api/v1/billing/uptime-tick`, `GET /api/v1/recording/session-policy/:installationId`

No bearer secrets, no shared keys.

## Charge model

Per the platform's CT economy:

- **Bot uptime**: CT/min by instance size (`nano` / `micro` / `small`).
  Recording itself is included.
- **Live Transcription** (optional):
  - **Platform Deepgram key** → user pays extra CT for transcription minutes
  - **BYO Deepgram key** → no transcription surcharge

## Development

```sh
npm install
npm run dev   # tsx watch on src/index.ts worker
npm test
```

Locally the worker is normally not run by hand — core-server's
worker-spawner starts a container per session. Run it manually only when
debugging the SSE consumer or Deepgram integration against a running
core-server; the `.env.example` shows the per-session env to fill in.

Pre-push hook runs the full test suite (cfg-* convention). No `--no-verify` —
fix the test instead.

## Tracking

cfg-core-dev-tools#117 (cfg-server-disrecord epic).
