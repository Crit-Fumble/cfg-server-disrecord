/**
 * Deepgram Client — Factory for streaming transcription connections.
 *
 * Each transcription session creates one DeepgramStreamingClient per speaker.
 * Not a singleton — clients are created per audio stream and disposed on close.
 */

export { DeepgramStreamingClient } from './client.js'
export type { DeepgramStreamOptions, TranscriptEvent, DeepgramWord } from './types.js'

import { DeepgramStreamingClient } from './client.js'
import type { DeepgramStreamOptions } from './types.js'

/** Create a new Deepgram streaming client. One per speaker per session. */
export function createDeepgramStream(apiKey: string, options?: DeepgramStreamOptions): DeepgramStreamingClient {
  return new DeepgramStreamingClient(apiKey, options)
}
