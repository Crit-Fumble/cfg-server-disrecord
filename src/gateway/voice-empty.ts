/**
 * Voice-empty tracking — "everyone has been gone for a while, so the session
 * is over".
 *
 * ## Why this lives in the worker
 *
 * The worker is *in* the voice channel, so channel membership is something it
 * observes directly. core-server's equivalent has to ask Discord over REST
 * with the right bot token, and that has already caused a production incident
 * (2026-06-23: a platform-token read 403'd, fail-closed to "empty", and
 * auto-paused a full, actively-recording channel). An observer that is already
 * in the room cannot get that wrong.
 *
 * ## Why the grace period
 *
 * A momentary drop looks exactly like everyone leaving. Ending immediately
 * would kill a session because someone's wifi hiccuped — the same class of bug
 * as {@link ../gateway/voice-reconnect.ts}. So emptiness has to *persist* for
 * the full grace window, and any rejoin cancels it outright. A rejoin followed
 * by another departure restarts the full window rather than resuming the old
 * one: the relevant question is always "how long has it been empty *now*".
 *
 * Deliberately dumb about identity — the caller filters bots — so the
 * bot-exclusion rule lives in exactly one place, and this stays a pure,
 * clock-injected unit.
 */

export interface VoiceEmptyTrackerOptions {
  /** How long the channel must stay empty before it counts. */
  graceMs: number
}

export class VoiceEmptyTracker {
  /** Timestamp the channel became empty, or null while anyone is present. */
  private emptySince: number | null = null

  constructor(private readonly opts: VoiceEmptyTrackerOptions) {}

  /**
   * Report the current human occupants. Idempotent for repeated identical
   * reports — voiceStateUpdate also fires for mute, deafen, video and stream
   * changes, and a redundant "still empty" must not push the deadline out.
   */
  setMembers(humanIds: readonly string[], nowMs: number): void {
    if (humanIds.length > 0) {
      this.emptySince = null
      return
    }
    if (this.emptySince === null) this.emptySince = nowMs
  }

  /** When the channel will have been empty long enough, or null. */
  dueAt(): number | null {
    return this.emptySince === null ? null : this.emptySince + this.opts.graceMs
  }

  /** True once the channel has been continuously empty for the grace period. */
  isDue(nowMs: number): boolean {
    const due = this.dueAt()
    return due !== null && nowMs >= due
  }

  /** Forget any in-progress emptiness (e.g. after acting on it). */
  reset(): void {
    this.emptySince = null
  }
}
