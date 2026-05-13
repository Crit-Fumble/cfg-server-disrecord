/**
 * Deepgram WebSocket API types for real-time streaming transcription.
 *
 * Docs: https://developers.deepgram.com/docs/getting-started-with-live-streaming-audio
 */

/** Options for opening a Deepgram streaming connection. */
export interface DeepgramStreamOptions {
  model?: string // 'nova-3' (default)
  language?: string // 'en' (default)
  encoding?: string // 'linear16' (default)
  sampleRate?: number // 48000 (default — matches Discord Opus output)
  channels?: number // 1 (default — mono)
  punctuate?: boolean // true (default)
  interimResults?: boolean // false (default — only final transcripts)
  smartFormat?: boolean // improved capitalization, numbers, punctuation
  utteranceEndMs?: number // ms of silence before Deepgram fires UtteranceEnd (e.g. 1000)
  endpointing?: number | false // ms before finalizing after silence (default ~300, false to disable)
  keywords?: string[] // boosted terms, e.g. ["Pohlee:5", "Might:2"]
  /**
   * Phrase-level boost list — Nova-3 streaming only. Multi-word entries are
   * recognized as units (e.g. "kick 'em in the unmentionables") which is
   * dramatically more accurate than single-token `keywords` boosting on the
   * same phrase. Deepgram rejects the param on non-Nova-3 models with a 400
   * on handshake, so the caller must gate this on model selection. Boost
   * weights (`:N` suffix) are NOT valid on keyterms — pass bare phrases.
   */
  keyterms?: string[]
  /**
   * Emit per-frame VAD confidence events (`SpeechStarted`). We don't consume
   * them yet — they're enabled to populate Deepgram-side logs for future
   * fragmentation debugging. Cost-neutral.
   */
  vadEvents?: boolean
}

/** A single word with timing metadata. */
export interface DeepgramWord {
  word: string
  start: number
  end: number
  confidence: number
  punctuated_word?: string
}

/** One alternative transcription. */
export interface DeepgramAlternative {
  transcript: string
  confidence: number
  words: DeepgramWord[]
}

/** A single channel result. */
export interface DeepgramChannel {
  alternatives: DeepgramAlternative[]
}

/** Top-level transcription result from WebSocket. */
export interface DeepgramResult {
  type: 'Results'
  channel_index: number[]
  duration: number
  start: number
  is_final: boolean
  speech_final: boolean
  channel: DeepgramChannel
}

/** Metadata message sent when connection opens. */
export interface DeepgramMetadata {
  type: 'Metadata'
  transaction_key: string
  request_id: string
  sha256: string
  created: string
  duration: number
  channels: number
  models: string[]
  model_info: Record<string, unknown>
}

/** Deepgram UtteranceEnd message — fired when utterance_end_ms silence threshold is reached. */
export interface DeepgramUtteranceEnd {
  type: 'UtteranceEnd'
  last_word_end: number
  channel: number[]
}

/** Emitted transcript event — simplified for consumers. */
export interface TranscriptEvent {
  transcript: string
  confidence: number
  isFinal: boolean
  /** True when Deepgram detects end-of-utterance (complete thought). */
  speechFinal: boolean
  /** Cumulative audio duration in seconds at this point. */
  durationSec: number
  words: DeepgramWord[]
}
