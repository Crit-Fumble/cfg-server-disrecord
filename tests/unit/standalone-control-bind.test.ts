/**
 * Which interface the control server binds.
 *
 * ⛔ The regression this pins cost the entire self-host Docker path: the app's
 * bare-metal default (`127.0.0.1`) was used inside the container too, and a
 * process bound to a container's loopback is unreachable through
 * `docker run -p` — Docker forwards to eth0. The container booted, connected to
 * Discord and reported healthy FROM INSIDE, while the dashboard and the whole
 * control API served nothing to the host. There was no way to start a
 * recording, and nothing anywhere said so.
 *
 * Verified empirically before the fix: `curl 127.0.0.1:<published>/healthz`
 * from the host got connection-refused while the same request inside the
 * container returned `{"ok":true,"botReady":true}`.
 */

import { resolveStandaloneConfig } from '../../src/config.js'

const BASE = {
  DISRECORD_DISCORD_TOKEN: 'tok',
  CONTROL_PORT: '8080',
}

function withEnv(extra: Record<string, string | undefined>) {
  const saved = { ...process.env }
  Object.assign(process.env, BASE)
  // ⚠️ Object.assign would set the STRING "undefined" — process.env coerces
  // every value. Deleting is the only way to express "not set".
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return resolveStandaloneConfig()
  } finally {
    process.env = saved
  }
}

describe('control bind host', () => {
  it('defaults to loopback — safe for a bare-metal run', () => {
    // This default is what makes "no CONTROL_TOKEN ⇒ open" defensible.
    expect(withEnv({ CONTROL_HOST: undefined }).controlHost).toBe('127.0.0.1')
  })

  it('is overridable, which is how the image reaches the host', () => {
    expect(withEnv({ CONTROL_HOST: '0.0.0.0' }).controlHost).toBe('0.0.0.0')
  })
})
