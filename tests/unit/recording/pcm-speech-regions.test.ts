/**
 * Recovering speaking intervals from a per-speaker PCM file (#12).
 *
 * This is the load-bearing trick in the tuning harness: without real speaking
 * boundaries the replay exercises only Deepgram's `endpointing` and never our
 * forced `Finalize`, which is the control that actually decides segment length
 * in production. The boundaries come from the file's own silence structure, so
 * these specs pin that the structure is read the way the recorder wrote it.
 */

import {
  DEFAULT_MIN_SILENCE_MS,
  bytesToSec,
  detectSpeechRegions,
  secToBytes,
} from '../../../src/recording/pcm-speech-regions.js'
import { PCM_BYTES_PER_MS, createSilencePadState, padSilenceAndAppend } from '../../../src/recording/pcm-silence-pad.js'

/** `ms` of silence, exactly as `padSilenceAndAppend` synthesizes it. */
function silence(ms: number): Buffer {
  return Buffer.alloc(ms * PCM_BYTES_PER_MS)
}

/** `ms` of non-silent audio — a full-scale square wave, so no sample is zero. */
function tone(ms: number): Buffer {
  const buf = Buffer.alloc(ms * PCM_BYTES_PER_MS)
  for (let i = 0; i + 1 < buf.length; i += 2) {
    buf.writeInt16LE(i % 4 === 0 ? 8000 : -8000, i)
  }
  return buf
}

describe('detectSpeechRegions', () => {
  it('finds a single burst surrounded by padding', () => {
    const pcm = Buffer.concat([silence(1000), tone(500), silence(1000)])
    const regions = detectSpeechRegions(pcm)

    expect(regions).toHaveLength(1)
    expect(bytesToSec(regions[0].startByte)).toBeCloseTo(1.0, 2)
    expect(bytesToSec(regions[0].endByte)).toBeCloseTo(1.5, 2)
  })

  it('splits bursts separated by a real gap', () => {
    const pcm = Buffer.concat([tone(400), silence(2000), tone(400)])
    const regions = detectSpeechRegions(pcm)

    expect(regions).toHaveLength(2)
    expect(bytesToSec(regions[0].endByte)).toBeCloseTo(0.4, 2)
    expect(bytesToSec(regions[1].startByte)).toBeCloseTo(2.4, 2)
  })

  it('bridges silence shorter than the gap threshold', () => {
    // A brief run of digital silence inside one burst is not a speaker-end;
    // treating it as one would manufacture turn boundaries production never saw.
    const pcm = Buffer.concat([tone(400), silence(DEFAULT_MIN_SILENCE_MS - 100), tone(400)])
    const regions = detectSpeechRegions(pcm)

    expect(regions).toHaveLength(1)
    expect(bytesToSec(regions[0].endByte)).toBeCloseTo(0.4 + (DEFAULT_MIN_SILENCE_MS - 100) / 1000 + 0.4, 1)
  })

  it('closes a region where the audio stopped, not where the gap was detected', () => {
    // onSpeakerEnd fires when the speaker went quiet. If the region closed at
    // the END of the silence run instead, every measured turn would be a few
    // hundred ms too long and the latency numbers would be wrong.
    const pcm = Buffer.concat([tone(500), silence(3000), tone(500)])
    const regions = detectSpeechRegions(pcm)

    expect(bytesToSec(regions[0].endByte)).toBeCloseTo(0.5, 2)
  })

  it('keeps a region open when the recording stops mid-utterance', () => {
    const pcm = Buffer.concat([silence(500), tone(800)])
    const regions = detectSpeechRegions(pcm)

    expect(regions).toHaveLength(1)
    expect(regions[0].endByte).toBe(pcm.length)
  })

  it('drops sub-threshold specks', () => {
    const pcm = Buffer.concat([tone(20), silence(2000), tone(500)])
    const regions = detectSpeechRegions(pcm)

    expect(regions).toHaveLength(1)
    expect(bytesToSec(regions[0].startByte)).toBeCloseTo(2.02, 1)
  })

  it('returns nothing for a file that is entirely padding', () => {
    expect(detectSpeechRegions(silence(5000))).toEqual([])
  })

  it('recovers the boundaries the recorder actually wrote', () => {
    // End-to-end against the real padding helper rather than hand-built
    // buffers: a speaker who first talks 2s in, pauses, then talks again.
    const pad = createSilencePadState()
    const parts: Buffer[] = []
    const base = Date.now()
    let now = base
    jest.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      now = base
      padSilenceAndAppend(pad, 'u-1', tone(1)) // anchors the session origin
      now = base + 2000
      parts.push(padSilenceAndAppend(pad, 'u-1', tone(300)))
      now = base + 6000
      parts.push(padSilenceAndAppend(pad, 'u-1', tone(300)))
    } finally {
      jest.restoreAllMocks()
    }

    const regions = detectSpeechRegions(Buffer.concat(parts))
    expect(regions).toHaveLength(2)
    // First burst starts ~2s in (minus the 1ms anchor frame already counted).
    expect(bytesToSec(regions[0].startByte)).toBeCloseTo(2.0, 1)
    expect(bytesToSec(regions[1].startByte)).toBeCloseTo(6.0, 1)
  })
})

describe('byte/second conversion', () => {
  it('round-trips on a sample boundary', () => {
    expect(bytesToSec(secToBytes(12.5))).toBeCloseTo(12.5, 6)
  })

  it('rounds down to a whole sample so s16le alignment holds', () => {
    expect(secToBytes(1 / 96_000) % 2).toBe(0)
  })
})
