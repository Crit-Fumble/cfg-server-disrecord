/**
 * Caption shape passed between the live transcription pipeline
 * (RecordingSession → onTranscriptFinal) and the post-processor (VTT
 * subtitle generation).
 *
 * Mirrors cfg-core-server's `services/recording/caption-types.ts`.
 */

import type { DeepgramWord } from '../deepgram/types.js'

/**
 * One finalized utterance. `startSec` / `endSec` are seconds relative to
 * the session origin (the transcription pipeline ensures a single timeline
 * across all speakers).
 */
export interface CaptionEntry {
  speakerName: string
  speakerId: string
  transcript: string
  /** Per-word timing for VTT generation. Empty when not supplied. */
  words: DeepgramWord[]
  startSec: number
  endSec: number
}
