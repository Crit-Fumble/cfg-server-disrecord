/**
 * The session's transcript record stays bounded (#6).
 *
 * `captions[]` lives for the whole recording, so on a session running to the
 * 12hr ceiling it was the one structure that grew without any limit. These
 * specs pin the two things that bound it — word timings are not retained, and
 * a hard cap stops the array past a fail-safe ceiling — plus the invariant
 * that neither may corrupt the transcript the VTT is built from.
 */

import { CaptionAccumulator, DEFAULT_MAX_CAPTIONS } from '../../../src/recording/caption-accumulator.js'
import { generateVtt } from '../../../src/recording/vtt-generator.js'
import type { Logger } from '../../../src/logger.js'

function stubLogger(): Logger & { warnings: unknown[][] } {
  const warnings: unknown[][] = []
  const log = {
    warnings,
    warn: (...args: unknown[]) => void warnings.push(args),
    info: () => {},
    error: () => {},
    debug: () => {},
    fatal: () => {},
    trace: () => {},
    child: () => log,
  }
  return log as unknown as Logger & { warnings: unknown[][] }
}

function utterance(i: number, speakerId = 'u-1') {
  return {
    speakerName: `Speaker ${speakerId}`,
    speakerId,
    transcript: `utterance ${i}`,
    startSec: i,
    endSec: i + 0.5,
  }
}

describe('CaptionAccumulator — word timings are not retained', () => {
  it('keeps the fields the VTT needs and drops the word array', () => {
    const acc = new CaptionAccumulator({ logger: stubLogger() })
    // A caller may hand over a fuller live event; the extra field must not
    // survive into the session-lifetime record.
    acc.add({
      ...utterance(0),
      words: [{ word: 'hello', start: 0, end: 0.4, confidence: 0.99 }],
    } as Parameters<CaptionAccumulator['add']>[0])

    const [entry] = acc.snapshot()
    expect(entry.transcript).toBe('utterance 0')
    expect(entry.startSec).toBe(0)
    expect(entry.endSec).toBe(0.5)
    expect(entry.words).toBeUndefined()
  })

  it('still produces a complete, ordered VTT without word timings', () => {
    const acc = new CaptionAccumulator({ logger: stubLogger() })
    // Out of chronological order on purpose — finals can land late when one
    // speaker's stream lags another's.
    acc.add(utterance(2, 'u-2'))
    acc.add(utterance(0, 'u-1'))
    acc.add(utterance(1, 'u-1'))

    const vtt = generateVtt(acc.snapshot())
    expect(vtt).toContain('utterance 0')
    expect(vtt).toContain('utterance 1')
    expect(vtt).toContain('utterance 2')
    expect(vtt.indexOf('utterance 0')).toBeLessThan(vtt.indexOf('utterance 1'))
    expect(vtt.indexOf('utterance 1')).toBeLessThan(vtt.indexOf('utterance 2'))
  })
})

describe('CaptionAccumulator — hard entry cap', () => {
  it('stops appending at the cap and warns exactly once', () => {
    const logger = stubLogger()
    const acc = new CaptionAccumulator({ logger, maxEntries: 3 })
    for (let i = 0; i < 10; i++) acc.add(utterance(i))

    expect(acc.size).toBe(3)
    expect(acc.droppedCount).toBe(7)
    expect(logger.warnings).toHaveLength(1)
  })

  it('keeps the EARLIEST utterances so the transcript stays aligned with the mp3', () => {
    const acc = new CaptionAccumulator({ logger: stubLogger(), maxEntries: 3 })
    for (let i = 0; i < 10; i++) acc.add(utterance(i))

    // Truncated, never shifted: a listener following from t=0 sees cues that
    // match what they hear until the transcript simply ends.
    expect(acc.snapshot().map((e) => e.transcript)).toEqual([
      'utterance 0',
      'utterance 1',
      'utterance 2',
    ])
  })

  it('sits far above a worst-case 12hr session by default', () => {
    // ~1 final per 3s of speech (the forced-finalize window) over 12 hours is
    // ~14.4k entries even with steady cross-talk. The cap is a fail-safe, so
    // it must not be reachable by someone merely talking a lot.
    expect(DEFAULT_MAX_CAPTIONS).toBeGreaterThan(3 * 14_400)
  })
})

describe('CaptionAccumulator — redaction + snapshot isolation', () => {
  it('reports speakers who spoke but never consented', () => {
    const acc = new CaptionAccumulator({ logger: stubLogger() })
    acc.add(utterance(0, 'consenting'))
    acc.add(utterance(1, 'silent-objector'))
    acc.add(utterance(2, 'consenting'))

    const redacted = acc.redactedSpeakerIds(new Set(['consenting']))
    expect(Array.from(redacted)).toEqual(['silent-objector'])
  })

  it('hands out a copy — post-process rewrites entries during the silence trim', () => {
    const acc = new CaptionAccumulator({ logger: stubLogger() })
    acc.add(utterance(5))

    const snapshot = acc.snapshot()
    snapshot[0].startSec = 999
    snapshot[0].transcript = 'clobbered'

    expect(acc.snapshot()[0].startSec).toBe(5)
    expect(acc.snapshot()[0].transcript).toBe('utterance 5')
  })
})
