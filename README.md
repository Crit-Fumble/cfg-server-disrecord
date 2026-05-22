# cfg-server-disrecord — unified Discord voice recording container

One Docker image, two modes:

- **`serve`** — the standalone unified recording container. Boots its own
  Discord bot, joins voice on a `/resesh start` slash command, captures
  opus, mixes an MP3, transcribes with a BYO Deepgram key, and posts a
  Discord thread — with **zero** core-server involvement. Operate it via
  Discord slash commands or a localhost HTTP control API.
- **`worker`** — the legacy per-session worker. cfg-core-server spawns it,
  it pulls opus over SSE, runs Deepgram, and POSTs transcripts + billing
  back. Still fully supported; it is the Docker default `CMD`.

- **License**: AGPL-3.0-only

## Self-host quickstart (`serve` mode)

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

5. **Run the container** in `serve` mode:

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

### HTTP control API (localhost)

The `serve` container exposes a control API on `127.0.0.1:${CONTROL_PORT}`.
When `CONTROL_TOKEN` is set, every `/v1/*` request must carry
`Authorization: Bearer <token>`.

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

When CFG hosts the container (Phase 2), bot uptime is billed in CT/min and
recordings upload to DO Spaces. In `serve` mode none of that applies — you
bring your own bot and Deepgram key and pay Deepgram directly.

## Development

```sh
npm install
npm run dev          # tsx watch — worker mode
npm run dev:serve    # tsx watch — serve mode
npm test
npm run typecheck
npm run build
```

`@discordjs/opus` ships a native binding. Local installs may need
`npm rebuild @discordjs/opus`; unit tests mock it so they run without it.

Pre-push hook runs the full test suite (cfg-* convention). No `--no-verify`.

## Tracking

cfg-core-dev-tools#117 (cfg-server-disrecord epic). Unified-recording
container: Phase 1 (this branch) ships the standalone `serve` mode;
Phase 2 moves the gateway/voice/mixing out of core-server and adds the
phone-home billing/Spaces/consent-sync paths.
