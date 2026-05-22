/**
 * Deepgram Client — Factory for streaming transcription connections.
 *
 * Each transcription session creates one DeepgramStreamingClient per speaker.
 * Not a singleton — clients are created per audio stream and disposed on close.
 *
 * Clients are built with a token provider (see `token-provider.ts`), not a
 * static key — platform mode mints a short-lived grant token per websocket.
 */

export { DeepgramStreamingClient } from './client.js'
export type { DeepgramStreamOptions, TranscriptEvent, DeepgramWord } from './types.js'
export type { DeepgramCredential, DeepgramTokenProvider } from './client.js'
export { buildDeepgramTokenProvider } from './token-provider.js'

import { DeepgramStreamingClient, type DeepgramTokenProvider } from './client.js'
import type { DeepgramStreamOptions } from './types.js'

/**
 * Create a new Deepgram streaming client. One per speaker per session. The
 * `tokenProvider` resolves the credential at connect time — see
 * `buildDeepgramTokenProvider`.
 */
export function createDeepgramStream(
  tokenProvider: DeepgramTokenProvider,
  options?: DeepgramStreamOptions,
): DeepgramStreamingClient {
  return new DeepgramStreamingClient(tokenProvider, options)
}
