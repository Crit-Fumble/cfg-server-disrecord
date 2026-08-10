/**
 * The self-host dashboard's HTML — the whole page, as one string.
 *
 * Split out of `dashboard.ts` purely for size: that file was 525 lines against
 * the 800 hard cap and the settings pane pushes it well past. Nothing here
 * changed in the move.
 *
 * ⛔ THIS FILE IS ONE TEMPLATE LITERAL, so three characters are LIVE inside it
 * and none of them are type-checked:
 *
 *   `    closes the string early — even inside a comment. Use quotes instead.
 *   \\   is an ESCAPE. Writing \\n in the page's JS emits a real NEWLINE into
 *        the page, which broke `split(/[\\n,]/)` into two lines and killed the
 *        whole script. Double every backslash the page needs.
 *   ${   interpolates. It is the one of the three tsc catches.
 *
 * The page's JavaScript is a STRING: tsc never parses it, so a syntax error here
 * ships silently and takes the entire dashboard down at runtime. That is what
 * `dashboard-html.test.ts` exists to prevent — it parses the emitted script.
 *
 * Kept as a string rather than a served .html file on purpose: the container
 * ships a single bundled `dist/`, and a separate asset would need copying into
 * the image and resolving at runtime, which is more moving parts than a page
 * this size is worth.
 */
/**
 * The page. Self-contained — no external stylesheet, script or font, so it
 * works on a container with no outbound internet access.
 *
 * Everything user-visible is written with `textContent`, never `innerHTML`:
 * guild and channel names come from Discord and are controlled by whoever
 * administers that server, so treating them as markup would be an injection
 * into the operator's own dashboard.
 */
export const DASHBOARD_HTML = `<!doctype html>
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
  select, input[type=text], textarea { width: 100%; padding: 0.5rem; border-radius: 6px;
    border: 1px solid var(--line); background: var(--bg); color: var(--fg); font: inherit; }
  textarea { min-height: 4.5rem; resize: vertical; }
  .hint { color: var(--muted); font-size: 0.78rem; margin-top: 0.25rem; }
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

  <section>
    <h2>Settings</h2>
    <p class="empty" style="margin-top:0">
      Options for the server selected above, and per voice channel. Leave a field
      EMPTY to inherit — that is not the same as clearing it. Inherited values are
      shown greyed inside the box.
    </p>
    <div class="field">
      <label for="setScope">Applies to</label>
      <select id="setScope"></select>
    </div>
    <div class="field">
      <label for="setThreadName">Thread name template</label>
      <input id="setThreadName" type="text" autocomplete="off">
      <div class="hint">Tokens: {{voiceChannel}}, {{date}}, {{kind}}. Unknown tokens are left as written.</div>
    </div>
    <div class="row">
      <div class="field">
        <label for="setKeywords">Keywords (one per line)</label>
        <textarea id="setKeywords" autocomplete="off"></textarea>
      </div>
      <div class="field">
        <label for="setKeyterms">Key terms (one per line)</label>
        <textarea id="setKeyterms" autocomplete="off"></textarea>
      </div>
    </div>
    <div class="row">
      <div class="field">
        <label for="setTranscription">Transcription</label>
        <select id="setTranscription">
          <option value="">Inherit</option>
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
      </div>
      <div class="field">
        <label for="setModel">Deepgram model</label>
        <input id="setModel" type="text" autocomplete="off">
      </div>
    </div>
    <div class="row">
      <div class="field">
        <label for="setLanguage">Deepgram language</label>
        <input id="setLanguage" type="text" autocomplete="off">
      </div>
      <div class="field">
        <label for="setOutputChannel">Post recordings to</label>
        <select id="setOutputChannel"></select>
      </div>
    </div>
    <div class="field">
      <label for="setOutputThread">Existing thread ID (optional)</label>
      <input id="setOutputThread" type="text" autocomplete="off">
    </div>
    <button id="setSave" class="primary">Save</button>
    <button id="setClear" class="danger">Clear these overrides</button>
  </section>

  <section>
    <h2>Backup</h2>
    <p class="empty" style="margin-top:0">
      Every server and channel setting, as one file. It carries no bot token, no
      Deepgram key and no platform identifiers, so it is safe to keep a copy of or
      hand to someone else. Consent decisions are NOT in here — they are a record
      about other people and never leave the container.
    </p>
    <button id="setExport">Download settings</button>
    <button id="setImport">Upload settings…</button>
    <input id="setFile" type="file" accept="application/json,.json" style="display:none">
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
  // A world with no settings 404s, which for the settings pane is the ordinary
  // blank-slate state, not an error. Opt in per call so nothing else silently
  // swallows a genuine 404.
  if (opts.absentIsNull && res.status === 404) return null;
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
  renderSettingsScope();
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

$('guild').addEventListener('change', () => {
  renderChannels();
  renderSettingsScope();
  loadSettings();
});

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


// ── Settings ────────────────────────────────────────────────────────────────
// Every field the store knows is rendered here, deliberately. PUT is a
// WHOLE-OBJECT REPLACE, so a field this form does not show is a field this form
// would silently delete on save — an operator who set deepgramModel over the API
// would lose it the first time someone pressed Save in the browser.
//
// Empty means INHERIT, never "set to empty". That is why text inputs send
// nothing when blank and transcription is a three-way select rather than a
// checkbox: a checkbox has no "unset" state, so it would freeze inheritance the
// moment the pane loaded.
// Guards against an in-flight load overwriting what the operator is typing.
// Picking a scope starts an async fetch; without this the fetch lands a moment
// later and applySettings() wipes every keystroke made in the meantime. The
// counter additionally makes two fast scope changes resolve in the right order —
// only the newest request is allowed to paint.
let settingsRequest = 0;
const SETTING_INPUTS = ['setScope', 'setThreadName', 'setKeywords', 'setKeyterms',
  'setTranscription', 'setModel', 'setLanguage', 'setOutputChannel', 'setOutputThread',
  'setSave', 'setClear'];

function setSettingsBusy(busy) {
  for (const id of SETTING_INPUTS) $(id).disabled = busy;
}

function splitList(value) {
  // Backslashes are doubled here on purpose — see this file's header.
  return value.split(/[\\n,]/).map((s) => s.trim()).filter((s) => s.length > 0);
}

function renderSettingsScope() {
  const guild = guilds.find((g) => g.id === $('guild').value);
  const scope = $('setScope');
  const previous = scope.value;
  scope.replaceChildren();
  scope.appendChild(option('', 'This whole server (defaults)'));
  const out = $('setOutputChannel');
  const prevOut = out.value;
  out.replaceChildren();
  out.appendChild(option('', 'Inherit / same as the recording'));
  if (guild) {
    for (const c of guild.voiceChannels) scope.appendChild(option(c.id, 'Voice: ' + c.name));
    for (const c of guild.textChannels) out.appendChild(option(c.id, '#' + c.name));
  }
  if (previous) scope.value = previous;
  if (prevOut) out.value = prevOut;
}

function applySettings(override, effective) {
  // The box shows what THIS scope sets; the placeholder shows what it would
  // inherit if left blank. Putting the resolved value in the box instead would
  // make every inherited field look explicitly set, and saving would freeze it.
  const put = (id, ownValue, inheritedValue) => {
    $(id).value = ownValue === undefined || ownValue === null ? '' : String(ownValue);
    $(id).placeholder = inheritedValue === undefined || inheritedValue === null
      ? ''
      : 'Inherited: ' + String(inheritedValue);
  };
  put('setThreadName', override.threadNameTemplate, effective.threadNameTemplate);
  put('setModel', override.deepgramModel, effective.deepgramModel);
  put('setLanguage', override.deepgramLanguage, effective.deepgramLanguage);
  put('setOutputThread', override.outputThreadId, effective.outputThreadId);
  $('setKeywords').value = (override.keywords || []).join('\\n');
  $('setKeywords').placeholder = (effective.keywords || []).join(', ');
  $('setKeyterms').value = (override.keyterms || []).join('\\n');
  $('setKeyterms').placeholder = (effective.keyterms || []).join(', ');
  $('setTranscription').value = override.transcriptionEnabled === undefined
    ? ''
    : (override.transcriptionEnabled ? 'on' : 'off');
  $('setOutputChannel').value = override.outputChannelId || '';
}

function collectSettings() {
  const body = {};
  const text = (id, key) => { const v = $(id).value.trim(); if (v) body[key] = v; };
  text('setThreadName', 'threadNameTemplate');
  text('setModel', 'deepgramModel');
  text('setLanguage', 'deepgramLanguage');
  text('setOutputThread', 'outputThreadId');
  const keywords = splitList($('setKeywords').value);
  if (keywords.length) body.keywords = keywords;
  const keyterms = splitList($('setKeyterms').value);
  if (keyterms.length) body.keyterms = keyterms;
  if ($('setTranscription').value) body.transcriptionEnabled = $('setTranscription').value === 'on';
  if ($('setOutputChannel').value) body.outputChannelId = $('setOutputChannel').value;
  return body;
}

function settingsPath() {
  const guildId = $('guild').value;
  const scope = $('setScope').value;
  return scope
    ? '/v1/worlds/' + encodeURIComponent(guildId) + '/scenes/' + encodeURIComponent(scope)
    : '/v1/worlds/' + encodeURIComponent(guildId) + '/defaults';
}

async function loadSettings() {
  const guildId = $('guild').value;
  if (!guildId) return;
  const mine = ++settingsRequest;
  setSettingsBusy(true);
  try {
    let override, effective;
    if ($('setScope').value) {
      const data = await api(settingsPath());
      override = data.override || {};
      effective = data.effective || {};
    } else {
      // World scope has nothing above it, so its overrides ARE its effective
      // values. 404 is the blank-slate case: a server nobody has configured.
      const world = await api('/v1/worlds/' + encodeURIComponent(guildId), { absentIsNull: true });
      override = (world && world.defaults) || {};
      effective = {};
    }
    // A newer load started while this one was in flight — that one owns the
    // form now, and painting stale values over it would be worse than nothing.
    if (mine !== settingsRequest) return;
    applySettings(override, effective);
  } catch (err) {
    toast(err.message, true);
  } finally {
    if (mine === settingsRequest) setSettingsBusy(false);
  }
}

$('setScope').addEventListener('change', loadSettings);

$('setSave').addEventListener('click', async () => {
  if (!$('guild').value) { toast('Pick a server first.', true); return; }
  const button = $('setSave');
  button.disabled = true;
  try {
    await api(settingsPath(), { method: 'PUT', body: JSON.stringify(collectSettings()) });
    toast('Settings saved.');
    await loadSettings();
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
  }
});

$('setClear').addEventListener('click', async () => {
  const guildId = $('guild').value;
  if (!guildId) { toast('Pick a server first.', true); return; }
  const scope = $('setScope').value;
  try {
    if (scope) {
      await api(settingsPath(), { method: 'DELETE' });
    } else {
      // No DELETE for world defaults — an empty object IS cleared, and it
      // leaves scenes and grants untouched.
      await api(settingsPath(), { method: 'PUT', body: JSON.stringify({}) });
    }
    toast(scope ? 'Channel now inherits the server defaults.' : 'Server defaults cleared.');
    await loadSettings();
  } catch (err) {
    toast(err.message, true);
  }
});

$('setExport').addEventListener('click', async () => {
  try {
    // Fetched, not a plain link: the download needs the bearer token, and an
    // <a href> cannot carry one. The anchor is created and clicked in the same
    // task so nothing treats it as a popup.
    const file = await api('/v1/settings/export');
    const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'disrecord-settings.json';
    a.click();
    URL.revokeObjectURL(url);
    toast('Downloaded.');
  } catch (err) {
    toast(err.message, true);
  }
});

$('setImport').addEventListener('click', () => $('setFile').click());

$('setFile').addEventListener('change', async () => {
  const file = $('setFile').files && $('setFile').files[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    // Import REPLACES the whole document, so say so before doing it — this is
    // the one control on the page that can discard settings for servers the
    // operator is not currently looking at.
    if (!confirm('Replace ALL settings for every server with the contents of ' + file.name + '?')) return;
    const result = await api('/v1/settings/import', { method: 'PUT', body: JSON.stringify(parsed) });
    toast('Imported ' + (result && result.worlds !== undefined ? result.worlds : '?') + ' server(s).');
    await loadSettings();
  } catch (err) {
    toast(err.message === undefined ? 'That file is not valid JSON.' : err.message, true);
  } finally {
    // Same file twice in a row must still fire a change event.
    $('setFile').value = '';
  }
});

refresh();
setInterval(refresh, 4000);
</script>
</body>
</html>`
