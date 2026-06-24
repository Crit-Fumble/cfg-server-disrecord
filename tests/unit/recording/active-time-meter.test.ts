import { ActiveTimeMeter } from '../../../src/recording/active-time-meter.js'

const MIN = 60_000

describe('ActiveTimeMeter', () => {
  it('bills the full window when recording continuously', () => {
    const m = new ActiveTimeMeter()
    m.start(0)
    expect(m.flushMinutes(15 * MIN)).toBeCloseTo(15)
  })

  it('bills the active window that precedes a pause, even when the tick fires while paused (the 2026-06-23 regression)', () => {
    const m = new ActiveTimeMeter()
    m.start(0)
    m.pause(10 * MIN) // ~10 active minutes, then paused
    // First 15-min tick lands while paused: must bill the 10 active min, not 0.
    expect(m.flushMinutes(15 * MIN)).toBeCloseTo(10)
  })

  it('never bills paused time and never discards active time across a full session', () => {
    const m = new ActiveTimeMeter()
    m.start(0)
    m.pause(10 * MIN)
    expect(m.flushMinutes(15 * MIN)).toBeCloseTo(10) // tick while paused → 10 active
    m.resume(20 * MIN)
    expect(m.flushMinutes(25 * MIN)).toBeCloseTo(5) // final → 5 more active
    // Total billed 15 active min; paused window [10..20] never billed.
  })

  it('keeps counting active time across successive ticks', () => {
    const m = new ActiveTimeMeter()
    m.start(0)
    expect(m.flushMinutes(15 * MIN)).toBeCloseTo(15)
    expect(m.flushMinutes(30 * MIN)).toBeCloseTo(15)
    expect(m.flushMinutes(31 * MIN)).toBeCloseTo(1)
  })

  it('returns banked active time and stays frozen when flushed repeatedly while paused', () => {
    const m = new ActiveTimeMeter()
    m.start(0)
    m.pause(8 * MIN)
    expect(m.flushMinutes(15 * MIN)).toBeCloseTo(8)
    expect(m.flushMinutes(60 * MIN)).toBeCloseTo(0) // still paused → nothing new
  })

  it('treats pause() and resume() as idempotent', () => {
    const m = new ActiveTimeMeter()
    m.start(0)
    m.resume(2 * MIN) // already running → ignored
    m.pause(10 * MIN)
    m.pause(12 * MIN) // already paused → ignored, does not extend
    expect(m.flushMinutes(20 * MIN)).toBeCloseTo(10)
  })

  it('does not bill when paused immediately and never resumed', () => {
    const m = new ActiveTimeMeter()
    m.start(0)
    m.pause(0)
    expect(m.flushMinutes(45 * MIN)).toBeCloseTo(0)
  })
})
