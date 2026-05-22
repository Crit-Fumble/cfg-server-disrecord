/**
 * Control-API authentication.
 *
 * Two modes, picked by which credential the container was started with:
 *
 *   Self-host  — a static `CONTROL_TOKEN`. Every `/v1/*` request must carry
 *                `Authorization: Bearer <CONTROL_TOKEN>`. When no token is
 *                set the API is open (acceptable on a 127.0.0.1 bind).
 *
 *   CFG-hosted — the per-session JWT (`CORE_SERVER_TOKEN`). core-server
 *                minted this JWT — scope='disrecord-worker' + installationId
 *                claim, HS256 over AUTH_SECRET (see core-server
 *                `src/proxy/disrecord-auth.ts`) — and injected it into the
 *                container at spawn. When core-server later calls the
 *                control API it forwards the SAME JWT as the bearer, so the
 *                container authenticates by constant-time-comparing the
 *                inbound bearer against its own copy.
 *
 *                The container never receives AUTH_SECRET, so it cannot
 *                re-verify the HS256 signature. It does not need to: the
 *                token is unique per session and only core-server + this
 *                container ever hold it, so a byte-exact match already
 *                proves the caller is core-server. We additionally decode
 *                (un-verified) the JWT body to assert scope + installationId
 *                match — a cheap structural sanity check that catches a
 *                stale/cross-wired token, matching the claim shape
 *                `disrecord-auth.ts` produces.
 *
 * This module returns a pure predicate; `control/server.ts` wires it into
 * the Fastify `onRequest` hook.
 */

import { timingSafeEqual } from 'node:crypto'
import { decodeJwt } from 'jose'
import type { CfgHostedConfig } from '../config.js'

/** Worker scope claim — must match core-server's `DISRECORD_WORKER_SCOPE`. */
export const DISRECORD_WORKER_SCOPE = 'disrecord-worker' as const

export interface ControlAuthResult {
  ok: boolean
  /** Reason on failure — for logging only, never returned to the client. */
  reason?: string
}

export interface ControlAuthParams {
  /** CFG-hosted config — when present, per-session-JWT mode. */
  cfg?: CfgHostedConfig
  /** Static control token — self-host mode. */
  controlToken?: string
}

/** Constant-time string compare that tolerates length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/**
 * Build the control-API authenticator.
 *
 * Precedence: CFG-hosted JWT check wins when `cfg` is present; otherwise the
 * static-token check; otherwise (neither set) every request is allowed —
 * only safe on the 127.0.0.1 bind, which `control/server.ts` enforces for
 * exactly this case.
 */
export function createControlAuthenticator(
  params: ControlAuthParams,
): (authHeader: string | undefined) => Promise<ControlAuthResult> {
  const { cfg, controlToken } = params

  // CFG-hosted: the inbound bearer must be the exact per-session JWT.
  if (cfg) {
    return async (authHeader) => {
      if (!authHeader?.startsWith('Bearer ')) {
        return { ok: false, reason: 'missing bearer' }
      }
      const token = authHeader.slice('Bearer '.length).trim()
      if (!safeEqual(token, cfg.coreServerToken)) {
        return { ok: false, reason: 'token mismatch' }
      }
      // Structural sanity check on the (already-authenticated) token.
      try {
        const claims = decodeJwt(token)
        if (claims.scope !== DISRECORD_WORKER_SCOPE) {
          return { ok: false, reason: 'wrong scope' }
        }
        if (claims.installationId !== cfg.installationId) {
          return { ok: false, reason: 'installation mismatch' }
        }
      } catch {
        return { ok: false, reason: 'malformed jwt' }
      }
      return { ok: true }
    }
  }

  // Self-host: static token (or open when unset).
  return async (authHeader) => {
    if (!controlToken) return { ok: true }
    if (!authHeader?.startsWith('Bearer ')) {
      return { ok: false, reason: 'missing bearer' }
    }
    const token = authHeader.slice('Bearer '.length).trim()
    if (!safeEqual(token, controlToken)) {
      return { ok: false, reason: 'bad control token' }
    }
    return { ok: true }
  }
}
