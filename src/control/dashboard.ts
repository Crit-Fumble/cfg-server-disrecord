/**
 * Minimal self-host dashboard (#9).
 *
 * DisRecord is a back-end server, deliberately: a self-hoster brings their own
 * Discord bot and drives the container over its HTTP control API, normally by
 * building their own frontend the way cfg-core-server does. That is the right
 * architecture and this does not change it — but it puts the floor for a solo
 * self-hoster high. To record one session they must write an HTTP client and
 * know the control-API shape. One built-in page removes that floor without
 * turning DisRecord into a product.
 *
 * Deliberately ONE page, and deliberately small. Accounts, billing, campaigns
 * and transcript browsing are out of scope — those belong to core-server. If
 * this grows past a single page it has gone wrong.
 *
 * ── Self-host only ──────────────────────────────────────────────────────────
 * Not registered at all when CFG-hosted: core-server owns that surface, and
 * the container isn't reachable from a browser there anyway.
 *
 * ── Auth ────────────────────────────────────────────────────────────────────
 * The page itself is served unauthenticated, like `/healthz`, because it is
 * inert markup — every action it can take goes through `/v1/*`, which the
 * control server's auth hook already covers. With `CONTROL_TOKEN` set the page
 * asks for the token and sends it as a bearer; without one, the container is
 * on loopback and already open. `assertOpenSurfaceBindIsSafe` is what keeps that
 * reasoning true.
 */

import type { FastifyInstance } from 'fastify'
import type { RecordingService } from '../recording/recording-service.js'

/**
 * Refuse to serve the dashboard on a non-loopback bind without a
 * `CONTROL_TOKEN`.
 *
 * The self-host control server binds `127.0.0.1`, and the "no token ⇒ every
 * request allowed" rule is only defensible because of that. A dashboard
 * inherits the same bind — so if the bind ever widens, the token has to stop
 * being optional. A boot-time refusal beats a line in the docs: the failure it
 * prevents is an open, unauthenticated recording surface on a public
 * interface, which is not something anyone should learn about from a doc they
 * did not read.
 *
 * Today `standalone.ts` hardcodes the loopback bind in self-host, so this
 * cannot fire. It exists for whoever makes that configurable.
 */
export function assertOpenSurfaceBindIsSafe(
  host: string,
  controlToken: string | undefined,
  /**
   * What is about to be served, for the error message. Defaults to the
   * dashboard, which is what this originally guarded; the settings write API
   * asks the identical question, so it reuses this rather than restating the
   * reasoning.
   */
  surface = 'self-host dashboard',
): void {
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
  if (loopback || controlToken) return
  throw new Error(
    `refusing to serve the ${surface} on ${host} without CONTROL_TOKEN — ` +
      'a non-loopback bind with no auth is an open recording surface. Set CONTROL_TOKEN or bind 127.0.0.1.',
  )
}

/**
 * Register the dashboard page and the two read-only endpoints it needs.
 *
 * `/v1/guilds` and `/v1/diagnostics` sit under `/v1/` so they inherit the same
 * auth hook as every other control route — they expose guild and channel
 * names, which is not something to hand out unauthenticated just because a
 * browser asked.
 */
export function registerDashboard(app: FastifyInstance, service: RecordingService): void {
  app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(DASHBOARD_HTML))

  app.get('/v1/guilds', async () => ({ guilds: service.listGuilds() }))

  app.get('/v1/diagnostics', async () => service.diagnostics())
}

/**
 * The page. Self-contained — no external stylesheet, script or font, so it
 * works on a container with no outbound internet access.
 *
 * Everything user-visible is written with `textContent`, never `innerHTML`:
 * guild and channel names come from Discord and are controlled by whoever
 * administers that server, so treating them as markup would be an injection
 * into the operator's own dashboard.
 */
const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DisRecord</title>
<style>
  :root { color-scheme: light dark; --fg: #1a1a1a; --muted: #6b6b6b; --bg: #fbfbfb;
          --panel: #fff; --line: #e2e2e2; --accent: #4f46e5; --danger: #b42318; --ok: #067647; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #e8e8e8; --muted: #9a9a9a; --bg: #161618; --panel: #1e1e21;
            --line: #313136; --accent: #8b85f0; --danger: #f97066; --ok: #47cd89; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 2rem 1rem; background: var(--bg); color: var(--fg);
         font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  main { max-width: 46rem; margin: 0 auto; display: grid; gap: 1.25rem; }
  h1 { font-size: 1.35rem; margin: 0; }
  h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.06em;
       color: var(--muted); margin: 0 0 0.75rem; }
  header p { margin: 0.25rem 0 0; color: var(--muted); font-size: 0.9rem; }
  section { background: var(--panel); border: 1px solid var(--line);
            border-radius: 10px; padding: 1.1rem; }
  label { display: block; font-size: 0.82rem; color: var(--muted); margin-bottom: 0.3rem; }
  select, input[type=text] { width: 100%; padding: 0.5rem; border-radius: 6px;
    border: 1px solid var(--line); background: var(--bg); color: var(--fg); font: inherit; }
  .row { display: grid; gap: 0.75rem; grid-template-columns: 1fr 1fr; }
  @media (max-width: 34rem) { .row { grid-template-columns: 1fr; } }
  .field { margin-bottom: 0.75rem; }
  button { font: inherit; padding: 0.45rem 0.9rem; border-radius: 6px; cursor: pointer;
           border: 1px solid var(--line); background: var(--bg); color: var(--fg); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.danger { color: var(--danger); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .checkbox { display: flex; align-items: center; gap: 0.5rem; margin: 0.75rem 0; }
  .checkbox label { margin: 0; color: var(--fg); font-size: 0.9rem; }
  .rec { border: 1px solid var(--line); border-radius: 8px; padding: 0.8rem;
         margin-bottom: 0.6rem; display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
  .rec .meta { flex: 1 1 14rem; min-width: 0; }
  .rec code { font-size: 0.85rem; word-break: break-all; }
  .rec .sub { color: var(--muted); font-size: 0.82rem; }
  .pill { font-size: 0.75rem; padding: 0.1rem 0.5rem; border-radius: 99px;
          border: 1px solid var(--line); color: var(--muted); }
  .pill.live { color: var(--ok); border-color: var(--ok); }
  .empty { color: var(--muted); font-size: 0.9rem; }
  .status { display: flex; flex-wrap: wrap; gap: 0.4rem 1rem; font-size: 0.88rem; }
  .status b { font-weight: 600; }
  .banner { flex: 1 1 100%; border: 1px solid var(--danger); color: var(--danger);
            border-radius: 8px; padding: 0.6rem 0.8rem; font-size: 0.86rem; line-height: 1.45; }
  #toast { position: fixed; left: 50%; bottom: 1.25rem; transform: translateX(-50%);
    background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
    padding: 0.6rem 1rem; font-size: 0.88rem; max-width: 90vw; display: none; }
  #toast.err { border-color: var(--danger); color: var(--danger); }
  footer { color: var(--muted); font-size: 0.8rem; text-align: center; }
  footer code { font-size: 0.78rem; }
</style>
</head>
<body>
<main>
  <header>
    <h1>DisRecord</h1>
    <p>Self-host control panel. Everything here drives the same HTTP control API a custom frontend would.</p>
  </header>

  <section>
    <h2>Status</h2>
    <div id="status" class="status"><span class="empty">Loading…</span></div>
    <div id="tokenField" class="field" style="display:none; margin-top:0.9rem">
      <label for="token">CONTROL_TOKEN</label>
      <input id="token" type="text" autocomplete="off" placeholder="Required — this container has a control token set">
    </div>
  </section>

  <section>
    <h2>Start a recording</h2>
    <div class="field">
      <label for="guild">Server</label>
      <select id="guild"></select>
    </div>
    <div class="row">
      <div class="field">
        <label for="voice">Voice channel</label>
        <select id="voice"></select>
      </div>
      <div class="field">
        <label for="text">Transcript channel (optional)</label>
        <select id="text"></select>
      </div>
    </div>
    <div class="checkbox">
      <input id="transcription" type="checkbox" checked>
      <label for="transcription">Live transcription</label>
    </div>
    <button id="start" class="primary">Start recording</button>
  </section>

  <section>
    <h2>Active recordings</h2>
    <div id="recordings"><span class="empty">None.</span></div>
  </section>

  <section>
    <h2>Consent</h2>
    <p class="empty" style="margin-top:0">
      Grant or revoke consent for one Discord user on an active recording.
      Non-consenting speakers are never written to disk and appear as
      <code>[redacted]</code> in the transcript.
    </p>
    <div class="row">
      <div class="field">
        <label for="consentRec">Recording</label>
        <select id="consentRec"></select>
      </div>
      <div class="field">
        <label for="consentUser">Discord user ID</label>
        <input id="consentUser" type="text" autocomplete="off" placeholder="e.g. 123456789012345678">
      </div>
    </div>
    <button id="allow">Grant consent</button>
    <button id="deny" class="danger">Revoke consent</button>
  </section>

  <footer>
    Slash commands are not part of this container — it has no command surface by
    design. A consuming bot drives it over this same API; see <code>docs/SETUP.md</code>.
  </footer>
</main>
<div id="toast"></div>

<script>
const $ = (id) => document.getElementById(id);
let guilds = [];
let recordings = [];
/**
 * recordingId -> the action currently in flight for it.
 *
 * Lives OUTSIDE the row elements on purpose. Stopping blocks until the mix,
 * upload and Discord post are all done — often minutes — and the 4s poll
 * rebuilds every row in that window. State held on the button itself is
 * destroyed by that re-render, which puts a live "Stop" back under the
 * cursor mid-stop; the second click then 404s because the registry slot is
 * already released.
 */
const pending = new Map();

function token() { return sessionStorage.getItem('disrecord-token') || ''; }
$('token').value = token();
$('token').addEventListener('change', (e) => {
  sessionStorage.setItem('disrecord-token', e.target.value.trim());
  refresh();
});

function toast(message, isError) {
  const el = $('toast');
  el.textContent = message;
  el.className = isError ? 'err' : '';
  el.style.display = 'block';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.style.display = 'none'; }, 4000);
}

async function api(path, options) {
  const opts = options || {};
  const headers = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (token()) headers['authorization'] = 'Bearer ' + token();
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  if (res.status === 401) {
    $('tokenField').style.display = 'block';
    throw new Error('Unauthorized — set the CONTROL_TOKEN above.');
  }
  if (!res.ok) {
    let detail = res.statusText;
    try { const body = await res.json(); if (body && body.error) detail = body.error; } catch (_) {}
    throw new Error(detail);
  }
  return res.status === 204 ? null : res.json();
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  // textContent, never innerHTML — guild and channel names come from Discord.
  if (text !== undefined) node.textContent = text;
  return node;
}

function option(value, label) {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = label;
  return node;
}

function renderStatus(d) {
  const box = $('status');
  box.replaceChildren();
  const add = (label, value) => {
    const span = el('span');
    span.appendChild(el('b', null, label + ': '));
    span.appendChild(document.createTextNode(value));
    box.appendChild(span);
  };
  add('Bot', d.botReady ? (d.botTag || 'ready') : 'not ready');
  add('Servers', String(d.guildCount));
  add('Recording', String(d.activeRecordings));
  // ⚠️ The single most confusing failure this container has: consent buttons
  // that silently do nothing because Discord routes interactions to an HTTP
  // endpoint instead of the gateway. Say it where a human is looking, not only
  // in the boot log they will never scroll back to.
  if (d.interactionRoute === 'http') {
    const warn = el('div', 'banner');
    warn.appendChild(el('b', null, 'Consent buttons cannot fire. '));
    warn.appendChild(document.createTextNode(
      'This Discord application sends interactions to ' + (d.interactionsEndpointUrl || 'an HTTP endpoint') +
      ', not over the gateway, so clicks never reach this container and recordings capture silence. ' +
      'Use an application with no Interactions Endpoint URL, or grant consent below.'
    ));
    box.appendChild(warn);
  }
  const intents = el('span', 'empty', 'Intents: ' + d.intents.join(', '));
  intents.title =
    'Privileged intents (GuildMembers, MessageContent) must be enabled in the Discord Developer Portal. ' +
    'Discord refuses the gateway connection when they are not, so a bot that reached "ready" has them.';
  box.appendChild(intents);
}

function renderGuilds() {
  const guildSelect = $('guild');
  const previous = guildSelect.value;
  guildSelect.replaceChildren();
  for (const g of guilds) guildSelect.appendChild(option(g.id, g.name));
  if (previous) guildSelect.value = previous;
  renderChannels();
}

function renderChannels() {
  const guild = guilds.find((g) => g.id === $('guild').value);
  const voice = $('voice');
  const text = $('text');
  const prevVoice = voice.value;
  const prevText = text.value;
  voice.replaceChildren();
  text.replaceChildren();
  text.appendChild(option('', 'Same as voice channel'));
  if (guild) {
    for (const c of guild.voiceChannels) voice.appendChild(option(c.id, c.name));
    for (const c of guild.textChannels) text.appendChild(option(c.id, '#' + c.name));
  }
  if (prevVoice) voice.value = prevVoice;
  if (prevText) text.value = prevText;
}

function renderRecordings() {
  const box = $('recordings');
  box.replaceChildren();
  const picker = $('consentRec');
  const prevPick = picker.value;
  picker.replaceChildren();

  if (recordings.length === 0) {
    box.appendChild(el('span', 'empty', 'None.'));
    $('allow').disabled = true;
    $('deny').disabled = true;
    return;
  }
  $('allow').disabled = false;
  $('deny').disabled = false;

  for (const r of recordings) {
    picker.appendChild(option(r.recordingId, r.recordingId));

    const row = el('div', 'rec');
    const meta = el('div', 'meta');
    meta.appendChild(el('code', null, r.recordingId));
    const mins = Math.max(0, Math.round((Date.now() - r.startedAt) / 60000));
    meta.appendChild(
      el('div', 'sub', mins + 'm · ' + r.speakerCount + ' speaker' + (r.speakerCount === 1 ? '' : 's')),
    );
    row.appendChild(meta);
    row.appendChild(el('span', r.paused ? 'pill' : 'pill live', r.status));

    // An in-flight action disables BOTH buttons for that recording and shows
    // progress on the one that is running — and it survives this re-render
    // because "pending" is keyed on the recording, not held on the element.
    const busy = pending.get(r.recordingId);
    const toggleAction = r.paused ? 'resume' : 'pause';

    const toggle = el('button', null, busy === toggleAction ? PROGRESS[busy] : (r.paused ? 'Resume' : 'Pause'));
    toggle.disabled = !!busy;
    toggle.onclick = () => act(r.recordingId, toggleAction);
    row.appendChild(toggle);

    const stop = el('button', 'danger', busy === 'stop' ? PROGRESS.stop : 'Stop');
    stop.disabled = !!busy;
    stop.onclick = () => act(r.recordingId, 'stop');
    row.appendChild(stop);
    box.appendChild(row);

    // One row per speaker the session has seen, so an operator acts on an id
    // that is IN FRONT OF THEM. The form below still takes a hand-typed
    // snowflake for anyone not yet seen; this is for everyone who is.
    const c = r.consent || { consented: [], pending: [], declined: [] };
    const seen = [
      ...c.pending.map((id) => [id, 'pending']),
      ...c.consented.map((id) => [id, 'consented']),
      ...c.declined.map((id) => [id, 'declined']),
    ];
    for (const [uid, state] of seen) {
      const sub = el('div', 'rec');
      const who = el('div', 'meta');
      who.appendChild(el('code', null, uid));
      who.appendChild(el('div', 'sub', state === 'pending'
        ? 'undecided — audio is being DROPPED until someone allows it'
        : state === 'consented' ? 'audio is captured' : 'audio is dropped'));
      sub.appendChild(who);
      sub.appendChild(el('span', state === 'consented' ? 'pill live' : 'pill', state));

      const allow = el('button', null, 'Allow');
      allow.disabled = state === 'consented';
      allow.onclick = () => consentFor(r.recordingId, uid, true);
      sub.appendChild(allow);

      const skip = el('button', 'danger', 'Skip');
      skip.disabled = state === 'declined';
      skip.onclick = () => consentFor(r.recordingId, uid, false);
      sub.appendChild(skip);
      box.appendChild(sub);
    }
  }
  if (prevPick) picker.value = prevPick;
}

const PROGRESS = { pause: 'Pausing…', resume: 'Resuming…', stop: 'Stopping…' };
const DONE = { pause: 'Recording paused.', resume: 'Recording resumed.', stop: 'Recording stopped.' };

async function act(id, action) {
  if (pending.has(id)) return;
  pending.set(id, action);
  renderRecordings();
  try {
    await api('/v1/recordings/' + encodeURIComponent(id) + '/' + action, { method: 'POST' });
    toast(DONE[action]);
  } catch (err) {
    toast(err.message, true);
  } finally {
    pending.delete(id);
    refresh();
  }
}

$('guild').addEventListener('change', renderChannels);

$('start').addEventListener('click', async () => {
  const button = $('start');
  const guildId = $('guild').value;
  const voiceChannelId = $('voice').value;
  if (!guildId || !voiceChannelId) { toast('Pick a server and a voice channel.', true); return; }
  const body = { guildId: guildId, voiceChannelId: voiceChannelId, transcription: $('transcription').checked };
  if ($('text').value) body.textChannelId = $('text').value;
  button.disabled = true;
  button.textContent = 'Starting…';
  try {
    const result = await api('/v1/recordings', { method: 'POST', body: JSON.stringify(body) });
    toast('Started ' + result.recordingId + '.');
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
    button.textContent = 'Start recording';
    refresh();
  }
});

/**
 * Grant or revoke for ONE user on ONE recording, from the per-speaker rows.
 *
 * remember is deliberately false: these buttons mirror "Yes, this time only".
 * A DECLINE still persists regardless — that rule lives in the container, not
 * here, so the two consent surfaces cannot drift.
 */
async function consentFor(recordingId, discordUserId, consented) {
  try {
    await api('/v1/recordings/' + encodeURIComponent(recordingId) + '/consent', {
      method: 'POST',
      body: JSON.stringify({ discordUserId: discordUserId, consented: consented }),
    });
    toast(consented ? 'Consent granted.' : 'Consent revoked.');
    refresh();
  } catch (err) {
    toast(err.message, true);
  }
}

async function consent(consented) {
  const id = $('consentRec').value;
  const discordUserId = $('consentUser').value.trim();
  if (!id || !discordUserId) { toast('Pick a recording and enter a Discord user ID.', true); return; }
  try {
    await api('/v1/recordings/' + encodeURIComponent(id) + '/consent', {
      method: 'POST',
      body: JSON.stringify({ discordUserId: discordUserId, consented: consented }),
    });
    toast(consented ? 'Consent granted.' : 'Consent revoked.');
  } catch (err) {
    toast(err.message, true);
  }
}
$('allow').addEventListener('click', () => consent(true));
$('deny').addEventListener('click', () => consent(false));

async function refresh() {
  try {
    const [diagnostics, guildList, recordingList] = await Promise.all([
      api('/v1/diagnostics'),
      api('/v1/guilds'),
      api('/v1/recordings'),
    ]);
    $('tokenField').style.display = 'none';
    renderStatus(diagnostics);
    guilds = guildList.guilds;
    recordings = recordingList;
    renderGuilds();
    renderRecordings();
  } catch (err) {
    $('status').replaceChildren(el('span', 'empty', err.message));
  }
}

refresh();
setInterval(refresh, 4000);
</script>
</body>
</html>`
