/**
 * generateVtt — WebVTT output + redaction + per-part windowing.
 */
import { generateVtt } from '../../../src/recording/vtt-generator.js'
import type { CaptionEntry } from '../../../src/recording/caption-types.js'

function caption(over: Partial<CaptionEntry>): CaptionEntry {
  return {
    speakerName: 'Alice',
    speakerId: 'u1',
    transcript: 'hello there',
    words: [],
    startSec: 0,
    endSec: 2,
    ...over,
  }
}

describe('generateVtt', () => {
  it('emits a WEBVTT header for an empty caption list', () => {
    expect(generateVtt([]).trim()).toBe('WEBVTT')
  })

  it('renders a cue with speaker label and HH:MM:SS.mmm timing', () => {
    const vtt = generateVtt([caption({ startSec: 1.5, endSec: 3.25 })])
    expect(vtt).toContain('00:00:01.500 --> 00:00:03.250')
    expect(vtt).toContain('<v Alice>hello there')
  })

  it('redacts speakers in the redacted set', () => {
    const vtt = generateVtt([caption({ speakerId: 'u2' })], new Set(['u2']))
    expect(vtt).toContain('<v [redacted]>[redacted]')
    expect(vtt).not.toContain('hello there')
  })

  it('sorts cues by startSec regardless of arrival order', () => {
    // Real bug: late-joiner [redacted] placeholder fires synchronously on
    // consent while earlier-speaker finals from another stream are still
    // in flight; captions array ends up [A0, B45, A4, A8] in arrival
    // order, but cues must be chronological in the output.
    const captions = [
      caption({ speakerId: 'a', speakerName: 'A', transcript: 'first',  startSec: 0,   endSec: 3 }),
      caption({ speakerId: 'b', speakerName: 'B', transcript: 'late',   startSec: 45,  endSec: 46 }),
      caption({ speakerId: 'a', speakerName: 'A', transcript: 'second', startSec: 4,   endSec: 8 }),
      caption({ speakerId: 'a', speakerName: 'A', transcript: 'third',  startSec: 8.5, endSec: 11 }),
    ]
    const vtt = generateVtt(captions)
    const order = ['first', 'second', 'third', 'late'].map((t) => vtt.indexOf(t))
    // Each next string must appear later in the file than the previous one.
    expect(order.every((pos, i) => i === 0 || pos > order[i - 1])).toBe(true)
  })

  it('windows captions to a part offset + length', () => {
    const captions = [
      caption({ startSec: 1, endSec: 2, transcript: 'first' }),
      caption({ startSec: 50, endSec: 52, transcript: 'second' }),
    ]
    const vtt = generateVtt(captions, new Set(), { offsetSec: 40, lengthSec: 20 })
    expect(vtt).toContain('second')
    expect(vtt).not.toContain('first')
    // Shifted into part-local time: 50 - 40 = 10s.
    expect(vtt).toContain('00:00:10.000')
  })
})
