# cfg-server-disrecord — unified Discord voice recording container

One Docker image, one `serve` mode that runs in two configurations from the
same build:

- **Local-only** (default) — no `CORE_SERVER_URL`. The container boots its
  own Discord bot, joins voice on a `/resesh start` slash command, captures
  opus, mixes an MP3, transcribes with a BYO Deepgram key, and posts a
  Discord thread — with **zero** core-server involvement. Recordings land in
  a local directory. Operate it via Discord slash commands or a localhost
  HTTP control API.
- **CFG-hosted** — `CORE_SERVER_URL` + a per-session JWT + DO Spaces creds
  present. cfg-core-server spawns the container and proxies the HTTP control
  API to it; the container phones home for CT billing, uploads recordings to
  DO Spaces, and syncs consent. Omit those env vars and every phone-home path
  is a clean no-op — the same image runs purely local.

- **License**: AGPL-3.0-only

## Self-host quickstart (local-only)

You need a Discord bot and (optionally) a Deepgram API key.

1. **Create a Discord bot** at <https://discord.com/developers/applications>.
   On the **Bot** tab, enable the **Server Members Intent** and **Message
   Content Intent**. Copy the **bot token** and the **Application ID**.
2. **Invite the bot** to your server with the `bot` + `applications.commands`
   scopes and the **Connect**, **Speak**, **Send Messages**, and **Create
   Public Threads** permissions.
3. **Configure `.env`** — copy `.env.example` and fill in at least:

   ```sh
   DISRECORD_DISCORD_TOKEN=<bot token>
   DISRECORD_DISCORD_CLIENT_ID=<application id>
   DEEPGRAM_API_KEY=<deepgram key>   # omit for record-only (no transcript)
   OUTPUT_DIR=/data/recordings
   CONTROL_PORT=8080
   # CONTROL_TOKEN=<random secret>   # optional bearer auth for the HTTP API
   ```

4. **Register the slash commands** (one-shot — Discord caches them):

   ```sh
   docker run --rm --env-file .env cfg-server-disrecord:local register-commands
   ```

5. **Run the container** (`serve` is the default `CMD`):

   ```sh
   docker run -d --name disrecord \
     --env-file .env \
     -p 127.0.0.1:8080:8080 \
     -v disrecord-data:/data/recordings \
     cfg-server-disrecord:local serve
   ```

6. **Record.** Join a voice channel in Discord and run `/resesh start`.
   Click **Allow Recording** on the consent prompt. Use `/resesh pause`,
   `/resesh resume`, `/resesh status`, and `/resesh stop`. When you stop,
   the bot mixes the MP3, generates a VTT caption track (when transcription
   is on), posts them into a thread, and writes a copy to
   `OUTPUT_DIR/<recordingId>/`.

### HTTP control API

The container exposes a control API on `${CONTROL_PORT}`. Local-only it
binds `127.0.0.1` and, when `CONTROL_TOKEN` is set, every `/v1/*` request
must carry `Authorization: Bearer <token>`. CFG-hosted it binds `0.0.0.0`
and verifies the per-session JWT instead.

```
POST /v1/recordings            { guildId, voiceChannelId, textChannelId?, transcription? } → { recordingId }
POST /v1/recordings/:id/pause  → 204
POST /v1/recordings/:id/resume → 204
POST /v1/recordings/:id/stop   → 202   (post-processing async)
GET  /v1/recordings/:id        → { status, startedAt, speakerCount, paused }
GET  /v1/recordings            → [ ... ]
GET  /healthz                  → { ok, botReady, activeRecordings }
```

The bundled `disrecord` CLI wraps it: `disrecord status [id]`,
`disrecord start` (reads `START_GUILD_ID` / `START_VOICE_CHANNEL_ID`),
`disrecord stop <id>`.

### One recording per server

Discord allows a bot only one voice connection per server, so the
container records **one session per guild** at a time. A second
`/resesh start` (or `POST /v1/recordings`) for the same guild is rejected
with a clear conflict error. Different servers record concurrently.

## Charge model (CFG-hosted only)

When CFG hosts the container, bot uptime is billed in CT/min and recordings
upload to DO Spaces. Local-only none of that applies — you bring your own
bot and Deepgram key and pay Deepgram directly. CFG-hosted vs local-only is
decided purely by whether `CORE_SERVER_URL` is set; see `.env.example`.

## Development

```sh
npm install
npm run dev          # tsx watch — serve mode
npm test
npm run typecheck
npm run build
```

`@discordjs/opus` ships a native binding. Local installs may need
`npm rebuild @discordjs/opus`; unit tests mock it so they run without it.

Pre-push hook runs the full test suite (cfg-* convention). No `--no-verify`.

## Tracking

cfg-core-dev-tools#117 (cfg-server-disrecord epic). The unified-recording
container holds the whole recording engine; cfg-core-server keeps only
account/billing/consent data + container lifecycle and proxies the control
API. CFG-hosted recording works via optional phone-home.
