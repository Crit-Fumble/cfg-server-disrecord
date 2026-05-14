# DisRecord — environment setup

This doc is for **developers / operators** standing up a new ReSesh +
DisRecord environment (a fresh local dev tunnel, a staging deploy, a
fork). End users don't read this — they click "Add ReSesh to a Discord
server" inside the ReSesh app and that's their whole flow.

## What you're setting up

ReSesh has two halves:

1. **ReSesh** (frontend + bot identity) — a Discord application that owns
   the bot users see in their voice channel. Its bot token lives in
   `cfg-core-server`. Its OAuth client_id is public; the client_secret is
   secret-env.
2. **DisRecord** (backend container kind) — the per-session worker
   container spun up by core-server when a recording starts. Lives in
   `cfg-server-disrecord` (this repo). No Discord credentials of its own;
   everything is injected by core-server at session start.

For a new environment you need **one Discord application** (the ReSesh
one) — DisRecord is purely backend.

## Per-environment Discord applications

You should have a separate Discord application per environment so the bot
identity and Activity URL mappings don't conflict. A single Discord bot
token allows exactly one concurrent gateway WebSocket; if prod and dev
share a token whichever connects second wins.

| Environment | App name | Use |
|---|---|---|
| prod | `ReSesh` | the canonical ReSesh app users see. Domain: `core.crit-fumble.com`. |
| local dev | `[localhost] ReSesh` | mirror for working against `cfg-localdev.crit-fumble-web.workers.dev` |
| staging | `[staging] ReSesh` (when we have one) | not yet — Phase 1 |

## Step-by-step: setting up a new ReSesh Discord application

> If you're filling in a known-good state for an environment that already
> exists, jump to "What core-server needs in env" at the bottom.

### 1. Create the application

1. Go to https://discord.com/developers/applications
2. Click **New Application**
3. Name it (`[localhost] ReSesh`, `ReSesh`, etc.)

### 2. Bot tab — token + intents

1. Open the **Bot** tab
2. Click **Reset Token** (Discord only shows the token once). Save it.
3. Toggle ON these **Privileged Gateway Intents**:
   - Server Members Intent (for `GuildMembers`)
   - Message Content Intent (for `MessageContent`)
   - Presence Intent OFF (not used)
4. Toggle **Public Bot** to taste:
   - OFF during early testing — only you can add it
   - ON when ready for end-users to install it themselves

### 3. OAuth2 tab — client secret

1. Open the **OAuth2** tab (under Overview, not Activities)
2. Click **Reset Secret** → copy + save. This is the `client_secret`.
3. The **Redirects** field stays empty. The Activity OAuth flow uses RPC,
   not the redirect-URI redirect flow. Adding URLs here doesn't help
   Activity authorization.

### 4. Activities → URL Mappings

This is where Discord proxies its `discordsays.com` Activity iframe to
your app's actual domain.

**Root mapping** — the Activity iframe loads from here:

| Prefix | Target |
|---|---|
| `/` | `<your-domain>/discord/resesh` |

**Proxy path mappings** — Discord pre-fetches these so client-side
navigation + asset requests work inside the iframe:

| Prefix | Target |
|---|---|
| `/api` | `<your-domain>/api` |
| `/_next` | `<your-domain>/_next` |
| `/img` | `<your-domain>/img` |
| `/monitoring` | `<your-domain>/monitoring` |
| `/apps` | `<your-domain>/apps` |
| `/servers` | `<your-domain>/servers` |

Replace `<your-domain>` with `core.crit-fumble.com` for prod or
`cfg-localdev.crit-fumble-web.workers.dev` (or whatever your local
tunnel domain is) for dev.

### 5. Activities → Settings

> Status: not yet fully documented — we've gotten the bot install + voice
> connect flows working without diving deep into Activity Settings, but
> the in-iframe SDK OAuth path (currently parked) likely needs config
> here that the platform owner has from setting up CFG Core's Activity.

Things to look at when we tackle the Activity iframe path properly:

- Default Activity / Public Activity / Approval Required toggles
- Supported Platforms (Desktop / Mobile / Web)
- Maximum participant count
- Privacy policy URL (Discord requires this for Activities with OAuth)

If you're working on this and figure out the missing piece, please update
this section.

### 6. General Information

- Set the **App Icon** + **Description** end-users will see when adding
  the bot or launching the Activity. The platform's app icon ships in
  `cfg-core-browser`; use a matching asset here.

### 7. Install on your test guild

Bot install OAuth URL — substitute your client_id:

```
https://discord.com/oauth2/authorize?client_id=<YOUR_CLIENT_ID>&scope=bot+applications.commands&permissions=36768768
```

Permissions bitmask `36768768` = VIEW_CHANNEL + SEND_MESSAGES +
READ_MESSAGE_HISTORY + CONNECT + SPEAK + USE_VAD. Discord auto-creates
a role for the bot with these perms applied guild-wide.

Open the URL → pick your test server → Authorize. The bot appears in the
server's member list (offline until core-server's `disrecord-gateway`
connects).

## What core-server needs in env

After the app is set up, the operator-side configuration for core-server:

### Secrets (env)

| Var | Value |
|---|---|
| `DISRECORD_DISCORD_TOKEN` | Bot token from the Bot tab |
| `DISRECORD_DISCORD_CLIENT_SECRET` | Client secret from the OAuth2 tab |

### Non-secrets (`config/<env>.json`)

| Field | Value |
|---|---|
| `disrecordDiscordClientId` | The application's public client ID |
| `disrecordWorkerImage` | `cfg-server-disrecord:local` (dev) / registry path (prod) |
| `disrecordWorkerCoreServerUrl` | `http://host.docker.internal:3001` (Mac dev), `http://core-server:3001` (prod compose) |
| `disrecordContainerNetwork` | `null` (default bridge / dev) or compose project network name |

The cfg-core-browser side only needs `disrecordDiscordClientId` (public,
sent to the browser for the install button + Activity SDK init).

> **Gotcha — runtime config overlay.** The orchestration docker-compose
> mounts `orchestration/config-overrides/<env>.json` over
> `/app/config/<env>.json` inside the core-server container. So the
> repo's AGPL-default config is shadowed at runtime by the CFG-specific
> overlay. Any new field added in cfg-core-server's
> `config/<env>.json` **must also be added** to
> `orchestration/config-overrides/<env>.json` for the container to see
> it. The symptom of forgetting is "serverConfig field is empty in the
> container even though the AGPL repo file has the value." Same split
> applies for cfg-core-browser's config + its overlay.

## Smoke test the new environment

After everything's wired:

1. core-server starts → no boot errors about missing DisRecord env
2. Open `<your-domain>/apps/resesh` while signed in
3. Click "Add ReSesh to a Discord server" → install on your test guild
4. Join a voice channel in the test guild
5. Page detects the voice channel, shows the record button
6. Click record → bot joins voice, transcripts flow to core-server logs,
   stop button works (also out of voice — see voice-remote.ts fix)

If the bot fails to join voice with "Cannot fetch guild ..." the bot
isn't in that guild — repeat the install step. If it joins but no
transcripts, `DEEPGRAM_API_KEY` may not be set on core-server.

## Parked / known unknowns

- **Activity-iframe OAuth** — the `/discord/resesh` route inside Discord
  fails to complete `sdk.commands.authorize`. Discord rejects with both
  "Missing redirect_uri" (when omitted) and "RI cannot be used in the RPC
  OAuth Authorization flow" (when supplied). Working /discord/activity
  (CFG Core's prod Activity) uses the same SDK call shape, so the
  difference is portal-side. The web app surface `/apps/resesh` works in
  the meantime.
- **End-user install state detection** — `/apps/resesh` always shows the
  install banner; doesn't yet detect "ReSesh is already in this user's
  guilds" to hide it. Phase 1 work.
- **Auto-size by participant count** — recording always provisions a
  `micro` container today. Future: count voice members at provision time
  and pick the smallest size that fits.
- **Bot Personas with their own Discord apps using DisRecord** — Phase
  1+; tracked under cfg-core-dev-tools#133.
