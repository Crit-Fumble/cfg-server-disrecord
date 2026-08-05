/**
 * CaptionAccumulator — the session's transcript record, with a bounded heap.
 *
 * `SessionController` collects every finalized utterance for the whole
 * recording so post-processing can build the VTT at stop. That array used to
 * live on the controller and grow without any ceiling, which is a real
 * heap-growth path on the smallest CT tier for a session running to the 12hr
 * cap (#6).
 *
 * Two things bound it here:
 *
 *   1. **Word-level timings are not retained.** They were by far the heaviest
 *      field — one object per spoken word, each carrying start/end/confidence
 *      — and nothing downstream of the accumulator ever read them. `words` is
 *      consumed where it is produced: `RecordingSession` uses it to derive the
 *      utterance's duration before emitting, and `SessionController` forwards
 *      it to core-server per-utterance straight off the event. The VTT
 *      generator, the caption-derived pause finder and the post-process trim
 *      pass all work purely from speaker + text + start/end. So the retained
 *      record keeps those five fields and drops the rest.
 *
 *   2. **A hard entry cap**, as a fail-safe. Sized so it should never trip in
 *      a real session: with the current 3s forced-finalize a speaker produces
 *      at most ~1 final every 3s, so a 12-hour recording lands near 15k
 *      entries even with steady cross-talk. {@link DEFAULT_MAX_CAPTIONS} is
 *      ~3x that. Past the cap we STOP APPENDING rather than dropping the
 *      oldest, which keeps the transcript aligned with the mp3 a listener is
 *      following from t=0: the VTT is then simply truncated, not
 *      silently shifted, and the early parts of a split upload still get
 *      their cues. The drop is logged once, loudly, with a running count at
 *      session stop.
 *
 * Deliberately NOT spill-to-disk. The full spill proposed in #6 lowers the
 * sustained footprint but not the peak, because post-processing reads the
 * whole caption set back into memory anyway to sort, trim and window it — and
 * it would buy that with an on-disk format, a merge step to restore
 * chronological order, and a new mid-session failure mode when scratch fills.
 * The two measures above remove the dominant term for a fraction of the
 * moving parts; revisit if a real session is ever observed near the cap.
 */

import type { CaptionEntry } from './caption-types.js'
import type { Logger } from '../logger.js'

/**
 * Fail-safe ceiling on retained utterances. See the class doc for the
 * sizing — ~3x the worst case of a 12-hour session, so tripping it means
 * something has gone wrong, not that someone talked a lot.
 */
export const DEFAULT_MAX_CAPTIONS = 50_000

/**
 * What the accumulator keeps per utterance. Structurally a {@link CaptionEntry}
 * minus `words` — expressed as the parameter type so the omission is enforced
 * at the call site rather than trusted to a comment.
 */
export type RetainedCaption = Omit<CaptionEntry, 'words'>

export interface CaptionAccumulatorParams {
  logger: Logger
  /** Override the entry cap. Defaults to {@link DEFAULT_MAX_CAPTIONS}. */
  maxEntries?: number
}

export class CaptionAccumulator {
  private readonly entries: RetainedCaption[] = []
  private readonly maxEntries: number
  private readonly logger: Logger
  private dropped = 0
  private capWarned = false

  constructor(params: CaptionAccumulatorParams) {
    this.logger = params.logger
    this.maxEntries = params.maxEntries ?? DEFAULT_MAX_CAPTIONS
  }

  /**
   * Record one finalized utterance. Only the five fields the VTT pipeline
   * actually consumes are copied in — a caller holding a fuller event may
   * pass it directly, and the extra fields are left behind rather than
   * retained for the rest of the session.
   */
  add(entry: RetainedCaption): void {
    if (this.entries.length >= this.maxEntries) {
      this.dropped++
      if (!this.capWarned) {
        this.capWarned = true
        this.logger.warn(
          { maxEntries: this.maxEntries },
          'caption cap reached — further utterances are not retained; the VTT will be truncated at this point (#6)',
        )
      }
      return
    }
    this.entries.push({
      speakerName: entry.speakerName,
      speakerId: entry.speakerId,
      transcript: entry.transcript,
      startSec: entry.startSec,
      endSec: entry.endSec,
    })
  }

  /** Utterances retained so far. */
  get size(): number {
    return this.entries.length
  }

  /** Utterances refused because the cap was already reached. */
  get droppedCount(): number {
    return this.dropped
  }

  /**
   * Copy of the retained record for post-processing. A copy, not the live
   * array — post-process re-sorts and rewrites entries during the silence
   * trim, and must not mutate what the session is still appending to.
   */
  snapshot(): CaptionEntry[] {
    return this.entries.map((e) => ({ ...e }))
  }

  /**
   * Speakers who appear in the transcript but are absent from `consented` —
   * i.e. whose cues must render as `[redacted]`.
   */
  redactedSpeakerIds(consented: Set<string>): Set<string> {
    const redacted = new Set<string>()
    for (const entry of this.entries) {
      if (!consented.has(entry.speakerId)) redacted.add(entry.speakerId)
    }
    return redacted
  }
}
