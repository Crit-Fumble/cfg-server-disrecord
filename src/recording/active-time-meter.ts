/**
 * ActiveTimeMeter — accumulates ACTIVE (un-paused) recording time for billing.
 *
 * Replaces the old single sliding anchor in {@link SessionController}, which
 * discarded the active sub-window whenever a billing-tick boundary landed
 * during a pause. Prod incident 2026-06-23: a session recorded ~10 min, was
 * auto-paused, then the 15-min tick fired while paused and slid the anchor
 * forward — billing only the ~1-min post-tick sliver instead of the ~10 active
 * minutes.
 *
 * The meter is pause-correct in BOTH directions: paused time is never billed,
 * and active time is never discarded, regardless of how pauses and tick
 * boundaries interleave. Every method takes an explicit `now` (epoch ms) so the
 * accounting is pure and deterministic under test — callers pass `Date.now()`.
 */
export class ActiveTimeMeter {
  /** Active milliseconds banked since the last flush. */
  private activeMs = 0
  /** Epoch ms the current active window opened; null while paused/stopped. */
  private activeSince: number | null = null

  /** Begin (or restart) counting active time from `now`. */
  start(now: number): void {
    this.activeMs = 0
    this.activeSince = now
  }

  /** Freeze counting and bank the open active window. No-op while paused. */
  pause(now: number): void {
    if (this.activeSince != null) {
      this.activeMs += now - this.activeSince
      this.activeSince = null
    }
  }

  /** Resume counting from `now`. No-op while already running. */
  resume(now: number): void {
    if (this.activeSince == null) this.activeSince = now
  }

  /**
   * Return active minutes accrued since the last flush (or start) and reset the
   * accumulator to zero. Keeps counting from `now` when currently running;
   * stays frozen when paused. Safe to call repeatedly.
   */
  flushMinutes(now: number): number {
    if (this.activeSince != null) {
      this.activeMs += now - this.activeSince
      this.activeSince = now
    }
    const minutes = this.activeMs / 60_000
    this.activeMs = 0
    return minutes
  }
}
