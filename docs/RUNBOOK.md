# cfg-resesh — local runbook

How to bring up cfg-resesh against the Dev Den Discord guild
(`1153767296867770378`) and exercise a recording session end-to-end. Use this
ahead of any production deploy to validate the wiring on local hardware.

## One-time setup

### 1. Discord bot invite

The cfg-resesh Discord application (client_id `1504164101553656028`) needs to
be invited to the Dev Den guild with these scopes + intents:

- Scopes: `bot`, `applications.commands`
- Intents: Guild Voice States, Guild Members, Guild Messages, Message Content
- Permissions: Connect, Speak, Read Messages, Send Messages (in the test text
  channel)

Invite URL template:

```
https://discord.com/oauth2/authorize?client_id=1504164101553656028&scope=bot+applications.commands&permissions=3145728
```

Create a voice channel in Dev Den called `cfg-resesh-test` for the demo.

### 2. Local env

Copy `.env.example` to `.env`. Fill in:

```sh
RESESH_DISCORD_TOKEN=...        # bot token from the Discord Developer Portal
RESESH_DISCORD_PUBLIC_KEY=...   # public key from the same portal
PORT=4400
CORE_SERVER_URL=http://localhost:3001
CORE_SERVER_AUTH_SECRET=...     # also set the same value in cfg-core-server's env as RESESH_AUTH_SECRET
DOCKER_SOCKET_PATH=/var/run/docker.sock
RESESH_WORKER_IMAGE=cfg-resesh:local
LOG_LEVEL=info
```

The `CORE_SERVER_AUTH_SECRET` MUST match `RESESH_AUTH_SECRET` in
cfg-core-server's env. That's the shared bearer used in both directions.

### 3. GitHub Packages token (for docker build only)

Building the cfg-resesh container locally requires a token with `read:packages`
scope to pull `@crit-fumble/*` from GitHub Packages. The default `gh auth token`
typically does not include this scope. Two options:

```sh
# Option A: refresh gh CLI scopes
gh auth refresh -s read:packages

# Option B: use a classic PAT with read:packages scope
echo "//npm.pkg.github.com/:_authToken=ghp_…" > /tmp/cfg-resesh-npmrc-secret
# then point the build at it (see Build step below)
```

## Build

```sh
cd workspaces/cfg-resesh

# With gh CLI token (after `gh auth refresh -s read:packages`):
DOCKER_BUILDKIT=1 docker build \
  --secret id=npmrc,src=<(echo "//npm.pkg.github.com/:_authToken=$(gh auth token)") \
  -t cfg-resesh:local .

# With a PAT file:
DOCKER_BUILDKIT=1 docker build \
  --secret id=npmrc,src=/tmp/cfg-resesh-npmrc-secret \
  -t cfg-resesh:local .
```

## Run gateway locally (no container)

For iterating on gateway logic without rebuilding the container each time:

```sh
cd workspaces/cfg-resesh
npm run dev:gateway
# starts tsx watch on src/index.ts gateway
```

You should see:

```
{"mode":"gateway","level":30,"msg":"starting cfg-resesh gateway","port":4400}
{"level":30,"msg":"http api listening","port":4400}
{"level":30,"msg":"discord gateway ready","user":"…","id":"1504164101553656028"}
```

`/health` should return 200 with `{ "status": "ok", "discordReady": true }`.

```sh
curl http://localhost:4400/health
```

## Provision a recording session

You need cfg-core-server running locally too (because the worker will POST
transcripts + billing ticks back to it). Bring up the usual local stack:

```sh
# in another terminal
cd workspaces/cfg-core-server
npm run dev
```

Then POST a session against the gateway:

```sh
curl -X POST http://localhost:4400/v1/sessions \
  -H "authorization: Bearer $CORE_SERVER_AUTH_SECRET" \
  -H "content-type: application/json" \
  -d '{
    "userId": "<your discord user id>",
    "installationId": "test-inst-001",
    "size": "micro",
    "guildId": "1153767296867770378",
    "channelId": "<voice channel id in Dev Den>",
    "deepgramMode": "platform"
  }'
```

Expected: 201 with `{ "sessionId": "test-inst-001", "containerId": "…", "hostPort": null }`.

Then:
1. The bot joins the voice channel (mic icon shows up in Dev Den)
2. A worker container `cfg-resesh-worker-test-inst-001` starts
3. The worker GETs `/api/v1/recording/session-policy/test-inst-001` from
   core-server (logged)
4. The worker opens the SSE audio stream from gateway
5. Speak in the voice channel; transcripts log in core-server's terminal:
   ```
   {"level":30,"installationId":"test-inst-001","speakerId":"…","chars":N,"msg":"transcript received"}
   ```
6. After 15 minutes (or on session stop), a billing tick is logged.

## Stop a session

```sh
curl -X DELETE http://localhost:4400/v1/sessions/test-inst-001 \
  -H "authorization: Bearer $CORE_SERVER_AUTH_SECRET"
```

Expected: 204. The bot leaves voice; the worker container exits.

## Status check

```sh
curl http://localhost:4400/v1/sessions/test-inst-001/status \
  -H "authorization: Bearer $CORE_SERVER_AUTH_SECRET"
```

Returns the session record + uptime.

## Two-party conflict test

Try POSTing a second session for the same guild while the first is active —
should return 409:

```sh
# (first session still running from above)
curl -X POST http://localhost:4400/v1/sessions \
  -H "authorization: Bearer $CORE_SERVER_AUTH_SECRET" \
  -H "content-type: application/json" \
  -d '{
    "userId": "u-other",
    "installationId": "test-inst-002",
    "size": "micro",
    "guildId": "1153767296867770378",
    "channelId": "<any channel>",
    "deepgramMode": "disabled"
  }'
# → 409 with error: "guild_conflict"
```

This confirms the single-recording-per-guild enforcement that mirrors
Discord's underlying constraint.

## Known limitations (Phase 0)

- Recording state lives in gateway memory + Docker truth — survives gateway
  crashes via orphan-container reconciliation on boot but doesn't survive
  full host loss. Phase 1 → Redis.
- Transcripts are logged + emitted to voiceCaptionEvents SSE but not yet
  persisted to a transcript table — follow-up issue files when the demo
  proves stable.
- Worker resolveSpeakerName falls back to the Discord user ID until the
  session-policy endpoint populates speaker names (Friday demo limitation —
  the captions you'll see show user IDs, not names).
- DAVE-encrypted channels: voice connection still establishes but opus
  decode fails on every frame. DAVE canary handling is deferred to
  cfg-core-dev-tools#18.
