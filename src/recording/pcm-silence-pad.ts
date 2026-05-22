/**
 * PCM silence-padding helper.
 *
 * Extracted from cfg-core-server's `RecordingCapability` (the
 * `padSilenceAndAppend` method + its constants) so `pcm-capture.ts` stays
 * under the 800-line cap. Pure-ish — the only state is a per-speaker byte
 * counter the caller owns and threads in.
 *
 * The mixer (`amix`) lays every per-speaker PCM file on the same timeline
 * by index. To keep speakers aligned, each speaker's file must have its
 * byte position track wall-clock from a shared session origin: a speaker
 * who first talks 30s in needs 30s of leading silence in their file. This
 * helper synthesizes that silence.
 */

/**
 * Bytes of 48 kHz mono s16le PCM per millisecond of audio:
 *   48000 samples/s × 2 bytes/sample × 1 channel = 96000 B/s = 96 B/ms
 */
export const PCM_BYTES_PER_MS = 96

/**
 * Silence is emitted in chunks this large to avoid one giant
 * `Buffer.alloc(hundreds-of-MB)` when a speaker consents very late into a
 * long session. Each chunk covers ~1 second of audio (96 KB).
 */
export const SILENCE_CHUNK_BYTES = 96 * 1024

export interface SilencePadState {
  /** Wall-clock origin (ms). Lazily set on the first padded frame. */
  sessionStartedAtMs: number | null
  /** Per-speaker running byte count (real audio + silence padding). */
  bytesWritten: Map<string, number>
}

export function createSilencePadState(): SilencePadState {
  return { sessionStartedAtMs: null, bytesWritten: new Map() }
}

/**
 * Compute the silence that should precede `frame` in `userId`'s file so the
 * file's byte count matches the global wall-clock timeline, then return a
 * single buffer containing `(silence || nothing) + frame`.
 *
 * Side effect: advances `state.bytesWritten[userId]` by the total bytes
 * returned and lazily anchors `state.sessionStartedAtMs`. Callers MUST
 * write (or queue) the returned buffer or the counter drifts.
 *
 * Returns the frame unchanged when it's empty.
 */
export function padSilenceAndAppend(state: SilencePadState, userId: string, frame: Buffer): Buffer {
  if (frame.length === 0) return frame

  if (state.sessionStartedAtMs === null) {
    state.sessionStartedAtMs = Date.now()
  }

  const bytesWritten = state.bytesWritten.get(userId) ?? 0
  const elapsedMs = Date.now() - state.sessionStartedAtMs
  // Round DOWN to an even byte boundary so we never over-pad past global
  // time and s16le sample alignment stays correct.
  let expectedBytes = Math.floor(elapsedMs * PCM_BYTES_PER_MS)
  if (expectedBytes % 2 !== 0) expectedBytes -= 1

  const silenceBytes = Math.max(0, expectedBytes - bytesWritten)
  if (silenceBytes === 0) {
    state.bytesWritten.set(userId, bytesWritten + frame.length)
    return frame
  }

  const chunks: Buffer[] = []
  let remaining = silenceBytes
  while (remaining > 0) {
    const take = Math.min(remaining, SILENCE_CHUNK_BYTES)
    chunks.push(Buffer.alloc(take))
    remaining -= take
  }
  chunks.push(frame)

  state.bytesWritten.set(userId, bytesWritten + silenceBytes + frame.length)
  return Buffer.concat(chunks, silenceBytes + frame.length)
}
