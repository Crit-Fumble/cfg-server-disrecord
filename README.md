# cfg-server-disrecord — Discord voice recording skill server

**DisRecord is a "skill server"** — a server an *existing* Discord bot uses
to gain a new skill. It lets a bot "hear" a Discord voice call; recording and
transcription hook into that. DisRecord is **not a bot**: the consuming bot
hands DisRecord its token so DisRecord can join voice on the bot's behalf.

The container has **no slash-command surface**. It is driven entirely by an
HTTP control API. If you want slash commands, build your own bot that drives
this container — **ReSesh** (in `cfg-core-server` / `cfg-core-browser`) is the
reference implementation.

One Docker image, one `serve` mode that runs in two configurations from the
same build:

- **Local-only** (default) — no `CORE_SERVER_URL`. The container borrows your
  bot's token, joins voice on a control-API call, captures opus, mixes an
  MP3, transcribes with a BYO Deepgram key, and posts a Discord thread — with
  **zero** core-server involvement. Recordings land in a local directory.
  Operate it via the localhost HTTP control API (or the bundled CLI).
- **CFG-hosted** — `CORE_SERVER_URL` + a per-session JWT + object-storage creds
  present. cfg-core-server spawns the container and proxies the HTTP control
  API to it; the container phones home for CT billing, uploads recordings to
  object-storage, and syncs consent. Omit those env vars and every phone-home path
  is a clean no-op — the same image runs purely local.

- **License**: AGPL-3.0-only

## Self-host quickstart (local-only)

You need a Discord bot and (optionally) a Deepgram API key.

1. **Create a Discord bot** at <https://discord.com/developers/applications>.
   On the **Bot** tab, enable the **Server Members Intent** and **Message
   Content Intent**. Copy the **bot token**.
2. **Invite the bot** to your server with the `bot` scope and the
   **Connect**, **Speak**, **Send Messages**, and **Create Public Threads**
   permissions.
   ⚠️ **Do NOT set an Interactions Endpoint URL on this application.** Discord
   delivers interactions over the gateway *or* by HTTP to that URL — the two
   are mutually exclusive — and the consent buttons rely on the gateway. With a
   URL configured, clicking a consent button shows "didn't respond in time",
   the audio gate never opens, and the session records silence. A fresh bot has
   no such URL; the container warns loudly at boot if it finds one.

3. **Configure `.env`** — copy `.env.example` and fill in at least:

   ```sh
   DISRECORD_DISCORD_TOKEN=<bot token>
   DEEPGRAM_API_KEY=<deepgram key>   # omit for record-only (no transcript)
   OUTPUT_DIR=/data/recordings
   CONTROL_PORT=8080
   CONTROL_TOKEN=<random secret>     # REQUIRED when running the container
   ```

   ⚠️ `CONTROL_TOKEN` is required in Docker, not optional. The image binds the
   control server to `0.0.0.0` because a loopback bind inside a container is
   unreachable through `docker run -p` — Docker forwards to the container's
   eth0, not its loopback. A reachable surface must be authenticated, so the
   container refuses to boot on a wide bind without a token. Running from source
   on bare metal keeps the `127.0.0.1` default, where the token stays optional.

4. **Run the container** (`serve` is the default `CMD`):

   ```sh
   docker run -d --name disrecord \
     --env-file .env \
     -p 127.0.0.1:8080:8080 \
     -v disrecord-data:/data/recordings \
     cfg-server-disrecord:local serve
   ```

5. **Record.** Open <http://127.0.0.1:8080/> for the built-in dashboard, or
   drive the container over the HTTP control API (or the bundled CLI).
   `POST /v1/recordings` joins the voice channel, posts the in-Discord
   consent prompt, and begins capture. When you stop, the container mixes the
   MP3, generates a VTT caption track (when transcription is on), posts them
   into a thread, and writes a copy to `OUTPUT_DIR/<recordingId>/`. Want a
   `/resesh`-style slash UX? Build a bot that issues these control calls.

### Remembered consent

The consent prompt's **🔁 Yes, and remember** grants audio for this session
*and* records a channel-level opt-in, so that speaker isn't prompted again in
the same voice channel. **❌ Skip my voice** likewise records a channel-level
opt-out — someone who has said no is not asked every week. **✅ Yes, this time
only** deliberately remembers nothing.

Self-host keeps this in a small JSON file at `$OUTPUT_DIR/consent-store.json`
(override with `CONSENT_STORE_PATH`), so it lives on the volume you already
mount for recordings — nothing extra to configure. Deleting the file just means
everyone gets prompted again.

If the file is ever unreadable the container says so loudly and **refuses to
overwrite it**, running that session from memory instead: a failed parse must
never destroy a consent record.

### Consent

Recording is **opt-out by default**: a speaker's audio is dropped until they
consent. Two paths, both owned entirely by this container — core-server is not
involved in either:

- **In Discord** — the three buttons on the session-start announcement. These
  need gateway delivery, so the application must have no Interactions Endpoint
  URL (see the warning above).
- **From the dashboard or the control API** — `POST /v1/recordings/:id/consent`
  with `{ discordUserId, consented, remember? }`. The dashboard shows a row per
  speaker the session has seen, with Allow / Skip, so nobody has to hand-type a
  snowflake mid-session.

Both paths obey the same persistence rule: a **decline always** persists so
someone who said no is not asked again next week, a consent persists only with
`remember` ("Yes, and remember" vs "Yes, this time only").

### Built-in dashboard (self-host only)

Self-host serves a single-page control panel at `/` — pick a server and voice
channel, start/pause/stop a recording, watch what is live, and grant or revoke
consent for a user. It exists so recording one session does not first require
writing an HTTP client.

It is deliberately minimal, and stays that way: accounts, billing, campaigns
and transcript browsing belong to core-server, not here. It is **not** served
when CFG-hosted — core-server owns that surface, and the container isn't
reachable from a browser there anyway.

It inherits the control server's `127.0.0.1` bind. Since "no `CONTROL_TOKEN` ⇒
every request allowed" is only safe on loopback, the container **refuses to
boot** if the dashboard would be served on a wider bind without a token.

### HTTP control API

The container exposes a control API on `${CONTROL_PORT}`. Local-only it
binds `127.0.0.1` and, when `CONTROL_TOKEN` is set, every `/v1/*` request
must carry `Authorization: Bearer <token>`. CFG-hosted it binds `0.0.0.0`
and verifies the per-session JWT instead.

```
POST /v1/recordings            { guildId, voiceChannelId, textChannelId?, transcription? } → { recordingId }
POST /v1/recordings/:id/pause  → 204
POST /v1/recordings/:id/resume → 204
POST /v1/recordings/:id/stop   → 200   (BLOCKS until mix + upload + Discord post finish)
GET  /v1/recordings/:id        → { status, startedAt, speakerCount, paused }
GET  /v1/recordings            → [ ... ]
GET  /v1/guilds                → { guilds: [ { id, name, voiceChannels, textChannels } ] }   (self-host)
GET  /v1/diagnostics           → { botReady, botTag, guildCount, intents, activeRecordings } (self-host)
GET  /healthz                  → { ok, botReady, activeRecordings }
```

`stop` is deliberately synchronous: whoever calls it is usually about to kill
the container, so returning early would cut delivery off mid-upload. Budget a
generous client timeout — a long session takes minutes to mix and upload.

### Settings

The container keeps its own guild/channel config, so it needs no database and
no platform to be useful. The model is Foundry-shaped — **a guild is a world, a
voice channel is a scene**, and a scene inherits its world's defaults field by
field, overriding only what it names.

```
GET    /v1/worlds                              → { worlds: { <guildId>: { defaults, scenes, grants? } } }
GET    /v1/worlds/:guildId                     → one world (404 if unconfigured)
PUT    /v1/worlds/:guildId/defaults            world-level defaults          → { defaults }
GET    /v1/worlds/:guildId/scenes/:channelId   → { effective, override }
PUT    /v1/worlds/:guildId/scenes/:channelId   one channel's override        → { effective, override }
DELETE /v1/worlds/:guildId/scenes/:channelId   → 204   (clear it; inherits again)
GET    /v1/worlds/:guildId/grants              → { grants: [ ... ] }
PUT    /v1/worlds/:guildId/grants              replace them wholesale        → { grants }
GET    /v1/settings/export                     → the whole document, as a download
PUT    /v1/settings/import                     replace the whole document    → { worlds: <count> }
```

Settable per world or per channel: `keywords`, `keyterms`,
`transcriptionEnabled`, `deepgramModel`, `deepgramLanguage`, `outputChannelId`,
`outputThreadId`, `threadNameTemplate`.

Absent means *inherit*; an empty array or empty string means *explicitly none*,
so a channel can switch off keywords its world sets.

`keywords` and `keyterms` are applied to the next recording in that channel, and
**the container's own settings win** over anything the platform supplies —
self-host gets per-channel Deepgram boosts for the first time.

`threadNameTemplate` names the recording thread. Tokens are `{{voiceChannel}}`,
`{{date}}` and `{{kind}}` (`Recording` or `Transcription`); anything else is
left verbatim, so a typo shows up in the title instead of vanishing. Unset keeps
the built-in `<voice channel> - <date> - <kind>`.

The remaining fields are stored faithfully but not yet read by the recording
path.

A scene read returns **both** `effective` (what a recording will actually use)
and `override` (only what this channel sets itself) — rendering the resolved
value into a form would make every inherited field look explicitly set, and
saving it would freeze the inheritance.

**Export and import are the portability story.** `GET /v1/settings/export`
hands back the whole document as a file; `PUT /v1/settings/import` replaces it.
Safe to save, edit by hand and share, because the document carries **no
credentials and no platform identifiers** — bot tokens and Deepgram keys live
in the environment, and every id in the file is a Discord snowflake. An import
keeps what it can parse and drops the rest, so a partially hand-edited file
still applies the parts you got right.

⚠️ **CFG-hosted containers are read-only here** and answer `405` to every
write: the platform owns the file there, and two writers would race over a
document that is replaced whole. Reads work in both modes.

The bundled `disrecord` CLI wraps it: `disrecord status [id]`,
`disrecord start` (reads `START_GUILD_ID` / `START_VOICE_CHANNEL_ID`),
`disrecord stop <id>`.

### One recording per server

Discord allows a bot only one voice connection per server, so the
container records **one session per guild** at a time. A second
`POST /v1/recordings` for the same guild is rejected with a clear conflict
error. Different servers record concurrently.

## Charge model (CFG-hosted only)

When CFG hosts the container, **server uptime** is billed in CT/min by
instance size (the same slot-fraction model game servers use), and recordings
upload to object-storage. Live transcription on the platform Deepgram key is a
separate itemized `transcription` axis. Local-only none of that applies — you
bring your own bot and Deepgram key and pay Deepgram directly. CFG-hosted vs
local-only is decided purely by whether `CORE_SERVER_URL` is set; see
`.env.example`.

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

cfg-core-dev-tools#117 (cfg-server-disrecord epic). The skill-server
container holds the whole recording engine; cfg-core-server keeps only
account/billing/consent data + container lifecycle and proxies the control
API. CFG-hosted recording works via optional phone-home.
