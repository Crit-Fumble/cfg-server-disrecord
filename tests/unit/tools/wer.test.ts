/**
 * WER scoring for the Deepgram tuning harness (#12).
 *
 * This is the number that answers #10 — "is accuracy actually better?" — so a
 * settings sweep is only as trustworthy as this function. The specs pin the
 * two ways it could quietly lie: scoring formatting differences as accuracy
 * regressions, and mis-attributing which KIND of error a change introduced.
 */

import { extractVttText, normalizeWords, wordErrorRate } from '../../../tools/deepgram-tuning/wer.js'

describe('normalizeWords', () => {
  it('ignores case and punctuation', () => {
    // `punctuate` / `smart_format` are formatting choices, not accuracy ones.
    // Scoring them would make a comma look like a transcription error.
    expect(normalizeWords('Hello, world! Roll for initiative.')).toEqual([
      'hello',
      'world',
      'roll',
      'for',
      'initiative',
    ])
  })

  it("keeps apostrophes, which change the word", () => {
    expect(normalizeWords("we're")).toEqual(["we're"])
  })
})

describe('extractVttText', () => {
  it('strips cue indices, timings and voice spans', () => {
    const vtt = [
      'WEBVTT',
      '',
      '1',
      '00:00:01.000 --> 00:00:04.000',
      '<v Keawe>Roll for initiative.',
      '',
      '2',
      '00:00:05.000 --> 00:00:07.500',
      '<v Hob>Natural twenty.',
      '',
    ].join('\n')

    expect(extractVttText(vtt)).toBe('Roll for initiative. Natural twenty.')
  })

  it('passes a plain-text reference through untouched', () => {
    expect(extractVttText('just a corrected transcript')).toBe('just a corrected transcript')
  })
})

describe('wordErrorRate', () => {
  it('scores a perfect match as zero', () => {
    const result = wordErrorRate('roll for initiative', 'Roll for initiative!')
    expect(result.wer).toBe(0)
  })

  it('counts a substitution — the #10 failure mode', () => {
    // "Encourage" heard as "In College": one word became two, which is a
    // substitution plus an insertion against a 4-word reference.
    const result = wordErrorRate('i encourage the party', 'i in college the party')
    expect(result.substitutions).toBe(1)
    expect(result.insertions).toBe(1)
    expect(result.wer).toBeCloseTo(2 / 4, 6)
  })

  it('counts dropped words as deletions', () => {
    const result = wordErrorRate('one two three four', 'one four')
    expect(result.deletions).toBe(2)
    expect(result.substitutions).toBe(0)
    expect(result.wer).toBeCloseTo(2 / 4, 6)
  })

  it('counts invented words as insertions', () => {
    const result = wordErrorRate('one two', 'one uh two you know')
    expect(result.insertions).toBe(3)
    expect(result.wer).toBeCloseTo(3 / 2, 6)
  })

  it('reports the word counts a reviewer needs to sanity-check the rate', () => {
    const result = wordErrorRate('one two three', 'one two')
    expect(result.referenceWords).toBe(3)
    expect(result.hypothesisWords).toBe(2)
  })

  it('returns 0 rather than NaN for an empty reference', () => {
    // A missing reference must not poison the comparison table with NaN.
    expect(wordErrorRate('', 'anything at all').wer).toBe(0)
  })
})
