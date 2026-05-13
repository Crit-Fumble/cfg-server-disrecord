# cfg-server-disrecord — local runbook

How to bring up cfg-server-disrecord against the Dev Den Discord guild
(`1153767296867770378`) and exercise a recording session end-to-end. Use this
ahead of any production deploy to validate the wiring on local hardware.

## One-time setup

### 1. Discord bot invite

The cfg-server-disrecord Discord application (client_id `1504164101553656028`) needs:

**Privileged intents** — flip ON in the Developer Portal → Bot tab:
- Server Members Intent (for `GuildMembers`)
- Message Content Intent (for `MessageContent`)
- Leave Presence Intent OFF (not used)

**Invite URL** (scopes: `bot`+`applications.commands`; permissions
bitmask `36768768` = VIEW_CHANNEL + SEND_MESSAGES + READ_MESSAGE_HISTORY +
CONNECT + SPEAK + USE_VAD):

```
https://discord.com/oauth2/authorize?client_id=1504164101553656028&scope=bot+applications.commands&permissions=36768768
```

SPEAK is required even though the bot is listen-only — Discord won't fully
establish the voice session without it. USE_VAD is required for natural
voice recording (no push-to-talk).

Create a voice channel in Dev Den called `cfg-server-disrecord-test` for the demo.

### 1a. Dev vs prod bot (Alpha policy)

A single Discord bot token allows **one active gateway connection at a
time**. Dev and prod gateways can't both be online with the same token —
whichever connects second wins. Alpha policy:

- **Single app for now.** Local dev (`npm run dev:gateway`) and prod share
  client_id `1504164101553656028`. Only one runs at a time.
- **Switch to two apps before the first non-Hob user starts a recording in
  prod.** Create a `cfg-server-disrecord-dev` app for Dev Den, keep the current app
  for prod. Same code; the `DISRECORD_DISCORD_TOKEN` differs per env.

### 2. Local env

Copy `.env.example` to `.env`. Fill in:

```sh
DISRECORD_DISCORD_TOKEN=...        # bot token from the Discord Developer Portal
DISRECORD_DISCORD_PUBLIC_KEY=...   # public key from the same portal
PORT=4400
CORE_SERVER_URL=http://localhost:3001
DISRECORD_GATEWAY_BEARER=...       # shared bearer for the core-server → gateway hop only
DOCKER_SOCKET_PATH=/var/run/docker.sock
DISRECORD_WORKER_IMAGE=cfg-server-disrecord:local
LOG_LEVEL=info
```

`DISRECORD_GATEWAY_BEARER` MUST match `DISRECORD_GATEWAY_BEARER` in cfg-core-server's
env. It guards the core-server → gateway control plane only (provisioning,
stop, status).

Worker → core-server auth is a **per-session JWT** minted by core-server at
provisioning time and signed with `AUTH_SECRET` (the same key Auth.js uses
for user sessions). The gateway forwards the JWT verbatim into the worker
container as `CORE_SERVER_TOKEN` — gateway never holds the signing key, and
each token is scoped to a single installation with an expiry.

### 3. GitHub Packages token (for docker build only)

Building the cfg-server-disrecord container locally requires a token with `read:packages`
scope to pull `@crit-fumble/*` from GitHub Packages. The default `gh auth token`
typically does not include this scope. Two options:

```sh
# Option A: refresh gh CLI scopes
gh auth refresh -s read:packages

# Option B: use a classic PAT with read:packages scope
echo "//npm.pkg.github.com/:_authToken=ghp_…" > /tmp/cfg-server-disrecord-npmrc-secret
# then point the build at it (see Build step below)
```

## Build

```sh
cd workspaces/cfg-server-disrecord

# With gh CLI token (after `gh auth refresh -s read:packages`):
DOCKER_BUILDKIT=1 docker build \
  --secret id=npmrc,src=<(echo "//npm.pkg.github.com/:_authToken=$(gh auth token)") \
  -t cfg-server-disrecord:local .

# With a PAT file:
DOCKER_BUILDKIT=1 docker build \
  --secret id=npmrc,src=/tmp/cfg-server-disrecord-npmrc-secret \
  -t cfg-server-disrecord:local .
```

## Run gateway locally (no container)

For iterating on gateway logic without rebuilding the container each time:

```sh
cd workspaces/cfg-server-disrecord
npm run dev:gateway
# starts tsx watch on src/index.ts gateway
```

You should see:

```
{"mode":"gateway","level":30,"msg":"starting cfg-server-disrecord gateway","port":4400}
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

First mint a worker JWT in cfg-core-server (only core-server holds AUTH_SECRET).
This is what the production provisioning controller does automatically; for
direct-gateway curl testing you mint by hand:

```sh
# in another terminal — cfg-core-server's .env must be loaded
cd workspaces/cfg-core-server
export AUTH_SECRET=$(grep '^AUTH_SECRET=' .env | cut -d= -f2-)
WORKER_TOKEN=$(npx tsx scripts/mint-disrecord-token.ts test-inst-001 "<your discord user id>")
echo "$WORKER_TOKEN"
```

Then POST a session against the gateway:

```sh
curl -X POST http://localhost:4400/v1/sessions \
  -H "authorization: Bearer $DISRECORD_GATEWAY_BEARER" \
  -H "content-type: application/json" \
  -d "{
    \"userId\": \"<your discord user id>\",
    \"installationId\": \"test-inst-001\",
    \"size\": \"micro\",
    \"guildId\": \"1153767296867770378\",
    \"channelId\": \"<voice channel id in Dev Den>\",
    \"deepgramMode\": \"platform\",
    \"workerToken\": \"$WORKER_TOKEN\"
  }"
```

Expected: 201 with `{ "sessionId": "test-inst-001", "containerId": "…", "hostPort": null }`.

Then:
1. The bot joins the voice channel (mic icon shows up in Dev Den)
2. A worker container `cfg-server-disrecord-worker-test-inst-001` starts
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
  -H "authorization: Bearer $DISRECORD_GATEWAY_BEARER"
```

Expected: 204. The bot leaves voice; the worker container exits.

## Status check

```sh
curl http://localhost:4400/v1/sessions/test-inst-001/status \
  -H "authorization: Bearer $DISRECORD_GATEWAY_BEARER"
```

Returns the session record + uptime.

## Two-party conflict test

Try POSTing a second session for the same guild while the first is active —
should return 409:

```sh
# (first session still running from above)
curl -X POST http://localhost:4400/v1/sessions \
  -H "authorization: Bearer $DISRECORD_GATEWAY_BEARER" \
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
