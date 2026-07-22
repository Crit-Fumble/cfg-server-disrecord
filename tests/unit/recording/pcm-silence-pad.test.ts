/**
 * padSilenceAndAppend — wall-clock alignment of per-speaker PCM.
 */
import {
  createSilencePadState,
  padSilenceAndAppend,
  PCM_BYTES_PER_MS,
} from '../../../src/recording/pcm-silence-pad.js'

describe('padSilenceAndAppend', () => {
  it('returns the first frame unchanged (no leading silence)', () => {
    const state = createSilencePadState()
    const frame = Buffer.alloc(960, 1)
    const out = padSilenceAndAppend(state, 'u1', frame)
    expect(out).toBe(frame)
    expect(state.bytesWritten.get('u1')).toBe(frame.length)
  })

  it('returns an empty frame unchanged', () => {
    const state = createSilencePadState()
    const out = padSilenceAndAppend(state, 'u1', Buffer.alloc(0))
    expect(out.length).toBe(0)
  })

  it('anchors the session origin on the first padded frame', () => {
    const state = createSilencePadState()
    expect(state.sessionStartedAtMs).toBeNull()
    padSilenceAndAppend(state, 'u1', Buffer.alloc(960))
    expect(state.sessionStartedAtMs).not.toBeNull()
  })

  it('pads a late-joining speaker with leading silence to the wall-clock', () => {
    const state = createSilencePadState()
    // Anchor the origin 1000ms in the past so the next speaker is "late".
    state.sessionStartedAtMs = Date.now() - 1000
    const frame = Buffer.alloc(960, 7)
    const out = padSilenceAndAppend(state, 'late', frame)
    // ~1000ms × 96 B/ms of silence should precede the 960-byte frame.
    const expectedSilence = 1000 * PCM_BYTES_PER_MS
    expect(out.length).toBeGreaterThanOrEqual(expectedSilence)
    expect(out.length).toBeLessThanOrEqual(expectedSilence + frame.length + PCM_BYTES_PER_MS)
    // The frame's bytes land at the tail of the buffer.
    expect(out.subarray(out.length - frame.length)).toEqual(frame)
    // The leading region is zero-filled silence.
    expect(out[0]).toBe(0)
  })

  it('keeps each speaker on an independent byte counter', () => {
    // Time MUST be frozen here. Padding is wall-clock driven: the first call
    // anchors `sessionStartedAtMs`, and every later call pads to
    // `floor(elapsedMs * PCM_BYTES_PER_MS)`. PCM_BYTES_PER_MS is 96, so a
    // single millisecond between these two calls gives 'b' 96 bytes of leading
    // silence and the exact assertion below fails.
    //
    // That is not hypothetical — this test failed exactly once under full-suite
    // parallelism (disrecord#13) and passed on every serial re-run, which is
    // precisely the signature of a 1ms scheduling gap. Reproduced deliberately
    // with a 2ms busy-wait: expected 200, received 392 (= 200 + 2 × 96).
    jest.useFakeTimers().setSystemTime(new Date('2026-07-22T00:00:00Z'))
    try {
      const state = createSilencePadState()
      padSilenceAndAppend(state, 'a', Buffer.alloc(100))
      padSilenceAndAppend(state, 'b', Buffer.alloc(200))
      // With elapsed pinned at 0 no silence is inserted, so these are the raw
      // frame lengths — which is the property under test: per-speaker counters
      // are independent, not that padding happens to be zero.
      expect(state.bytesWritten.get('a')).toBe(100)
      expect(state.bytesWritten.get('b')).toBe(200)
    } finally {
      jest.useRealTimers()
    }
  })
})
