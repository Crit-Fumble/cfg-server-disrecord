/**
 * Control-API authenticator — static-token (self-host) + per-session-JWT
 * (CFG-hosted) modes.
 */
import { SignJWT } from 'jose'
import { createControlAuthenticator, DISRECORD_WORKER_SCOPE } from '../../../src/control/auth.js'
import type { CfgHostedConfig } from '../../../src/config.js'

/** Mint a JWT shaped like core-server's `disrecord-auth.ts` output. */
async function mintToken(opts: {
  secret: string
  scope?: string
  installationId?: string
  /** Subject — vary it to mint a distinct-but-valid token within one second. */
  subject?: string
}): Promise<string> {
  return new SignJWT({
    scope: opts.scope ?? DISRECORD_WORKER_SCOPE,
    installationId: opts.installationId ?? 'inst-1',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(opts.subject ?? 'user-1')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(opts.secret))
}

describe('createControlAuthenticator — self-host static token', () => {
  it('allows everything when no token is configured', async () => {
    const auth = createControlAuthenticator({})
    expect((await auth(undefined)).ok).toBe(true)
    expect((await auth('Bearer anything')).ok).toBe(true)
  })

  it('accepts the matching bearer token', async () => {
    const auth = createControlAuthenticator({ controlToken: 'secret' })
    expect((await auth('Bearer secret')).ok).toBe(true)
  })

  it('rejects a missing or wrong bearer token', async () => {
    const auth = createControlAuthenticator({ controlToken: 'secret' })
    expect((await auth(undefined)).ok).toBe(false)
    expect((await auth('Bearer wrong')).ok).toBe(false)
    expect((await auth('secret')).ok).toBe(false)
  })
})

describe('createControlAuthenticator — CFG-hosted per-session JWT', () => {
  const SECRET = 'auth-secret-xyz'

  async function hostedCfg(): Promise<CfgHostedConfig> {
    const coreServerToken = await mintToken({ secret: SECRET, installationId: 'inst-1' })
    return {
      coreServerUrl: 'http://core:3001',
      coreServerToken,
      installationId: 'inst-1',
      userId: 'user-1',
      ctPerMinute: 13,
      size: 'small',
    }
  }

  it('accepts the exact session token it was given', async () => {
    const cfg = await hostedCfg()
    const auth = createControlAuthenticator({ cfg })
    expect((await auth(`Bearer ${cfg.coreServerToken}`)).ok).toBe(true)
  })

  it('rejects a missing bearer', async () => {
    const cfg = await hostedCfg()
    const auth = createControlAuthenticator({ cfg })
    const res = await auth(undefined)
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('missing bearer')
  })

  it('rejects a different valid-looking token (not byte-equal)', async () => {
    const cfg = await hostedCfg()
    const auth = createControlAuthenticator({ cfg })
    // Distinct subject ⇒ a different-but-valid token even if minted the same
    // second; this isolates the byte-equality check from the structural one.
    const otherToken = await mintToken({ secret: SECRET, installationId: 'inst-1', subject: 'user-2' })
    const res = await auth(`Bearer ${otherToken}`)
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('token mismatch')
  })

  it('rejects a token whose scope is wrong', async () => {
    const wrongScopeToken = await mintToken({ secret: SECRET, scope: 'platform' })
    const cfg: CfgHostedConfig = {
      coreServerUrl: 'http://core:3001',
      coreServerToken: wrongScopeToken,
      installationId: 'inst-1',
      userId: 'user-1',
      ctPerMinute: 13,
      size: 'small',
    }
    const auth = createControlAuthenticator({ cfg })
    const res = await auth(`Bearer ${wrongScopeToken}`)
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('wrong scope')
  })

  it('rejects a token whose installationId does not match the config', async () => {
    const mismatchedToken = await mintToken({ secret: SECRET, installationId: 'inst-OTHER' })
    const cfg: CfgHostedConfig = {
      coreServerUrl: 'http://core:3001',
      coreServerToken: mismatchedToken,
      installationId: 'inst-1',
      userId: 'user-1',
      ctPerMinute: 13,
      size: 'small',
    }
    const auth = createControlAuthenticator({ cfg })
    const res = await auth(`Bearer ${mismatchedToken}`)
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('installation mismatch')
  })
})
