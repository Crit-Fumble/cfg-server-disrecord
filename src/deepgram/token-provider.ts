/**
 * Deepgram token providers — resolve the credential a per-speaker websocket
 * authenticates with, forked by the session's Deepgram mode.
 *
 *   platform — mint a fresh short-lived grant token from core-server on each
 *              websocket open. The platform's long-lived Deepgram key never
 *              enters the container. A mint failure resolves to `null`, which
 *              makes `DeepgramStreamingClient.connect()` reject — the caller
 *              falls back to record-only for that speaker.
 *   byok     — return the operator-supplied static key directly. No network.
 *   disabled — there is no provider; transcription is off entirely.
 */

import type { DeepgramCredential, DeepgramTokenProvider } from './client.js'
import type { CoreServerClient } from '../phone-home/core-client.js'
import type { Logger } from '../logger.js'

/**
 * Build the token provider for a recording session. Returns `null` when
 * transcription is disabled (no key / disabled mode) — the caller treats a
 * null provider as "record-only".
 */
export function buildDeepgramTokenProvider(opts: {
  mode: 'platform' | 'byok' | 'disabled'
  /** Static key — required for byok, ignored otherwise. */
  staticKey?: string
  /** Phone-home client — required for platform (mints grant tokens). */
  core: CoreServerClient
  logger?: Logger
}): DeepgramTokenProvider | null {
  if (opts.mode === 'disabled') return null

  if (opts.mode === 'byok') {
    if (!opts.staticKey) return null
    const credential: DeepgramCredential = { value: opts.staticKey, scheme: 'Token' }
    return () => credential
  }

  // platform — mint a short-lived grant token per websocket open.
  return async (): Promise<DeepgramCredential | null> => {
    const grant = await opts.core.fetchDeepgramToken()
    if (!grant) {
      opts.logger?.warn('platform Deepgram grant unavailable — speaker will not be transcribed')
      return null
    }
    return { value: grant.accessToken, scheme: 'Bearer' }
  }
}
