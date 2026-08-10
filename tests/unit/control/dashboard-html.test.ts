/**
 * The dashboard page is a STRING, so nothing in the toolchain reads it.
 *
 * `tsc` type-checks the template literal as a template literal — it never parses
 * the HTML or the JavaScript inside. A syntax error in the page therefore
 * compiles clean, ships, and takes the whole dashboard down at runtime with an
 * empty console. That happened: `\n` written inside the template is an ESCAPE
 * resolved at compile time, so `split(/[\n,]/)` reached the browser as a regex
 * broken across two real lines and killed the entire script — every control on
 * the page, not just the new one.
 *
 * These tests are the parser the toolchain does not give us.
 */
import vm from 'node:vm'
import { DASHBOARD_HTML } from '../../../src/control/dashboard-html.js'

/** The page's inline script, as the browser would receive it. */
function pageScript(): string {
  const match = /<script>([\s\S]*?)<\/script>/.exec(DASHBOARD_HTML)
  if (!match) throw new Error('no <script> block found in DASHBOARD_HTML')
  return match[1]!
}

describe('dashboard HTML', () => {
  it('emits JavaScript that actually parses', () => {
    // Compiles without running — a SyntaxError throws here, which is the point.
    expect(() => new vm.Script(pageScript())).not.toThrow()
  })

  it('wires every $(id) the script uses to an element that exists', () => {
    const html = DASHBOARD_HTML
    const ids = new Set<string>()
    for (const m of pageScript().matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)) ids.add(m[1]!)
    // A typo'd id is not a type error and not a parse error — it is a control
    // that silently does nothing, which is the hardest kind of bug to see.
    const missing = [...ids].filter((id) => !html.includes(`id="${id}"`))
    expect(missing).toEqual([])
    // Guard the guard: if the regex ever stops matching, this test would pass
    // vacuously while checking nothing.
    expect(ids.size).toBeGreaterThan(10)
  })

  it('leaves no unresolved template interpolation in the page', () => {
    expect(DASHBOARD_HTML).not.toContain('${')
  })

  it('keeps the settings pane wired to the settings API', () => {
    const script = pageScript()
    for (const path of ['/v1/worlds/', '/v1/settings/export', '/v1/settings/import']) {
      expect(script).toContain(path)
    }
  })

  it('never offers the voice channel as the recording thread’s parent', () => {
    // A recording is posted to a PRIVATE THREAD, and a thread's parent must be
    // a standard text channel — `createRecordingThread` rejects anything else
    // and `deliver()` then refuses to post at all. The old
    // "Same as voice channel" option was the DEFAULT selection, so the
    // documented click-path (README: open the dashboard, pick a server and a
    // voice channel, Start) recorded a full session and posted nothing to
    // Discord. Nothing failed loudly; the mp3 just never appeared.
    expect(pageScript()).not.toContain('Same as voice channel')
  })

  it('refuses to start a recording with no text channel picked', () => {
    const script = pageScript()
    // The guard has to be in the start handler, next to the guild/voice one —
    // a placeholder option alone would still POST an empty textChannelId.
    const start = script.slice(script.indexOf("$('start').addEventListener"))
    expect(start).toContain('!textChannelId')
    // Guard the guard: if the slice ever misses, the assertion above would be
    // checking an empty string.
    expect(start).toContain('/v1/recordings')
  })
})
