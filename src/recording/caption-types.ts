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
  /**
   * Per-word timing, as Deepgram delivered it.
   *
   * Optional because the session's retained transcript does NOT carry it:
   * word arrays were the bulk of the caption accumulator's heap and nothing
   * downstream reads them — the VTT generator, the caption-derived pause
   * finder and the post-process trim pass all work from speaker + text +
   * start/end alone (#6). It survives on the live `TranscriptFinalEvent`,
   * which is where the phone-home to core-server picks it up per-utterance.
   */
  words?: DeepgramWord[]
  startSec: number
  endSec: number
}
