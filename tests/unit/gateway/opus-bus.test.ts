/**
 * Unit tests for OpusBus + AudioChannel.
 */

import { OpusBus, type AudioChannelEvent } from '../../../src/gateway/opus-bus.js'

describe('OpusBus — channel lifecycle', () => {
  it('open() creates a new channel keyed on installationId', () => {
    const bus = new OpusBus()
    const ch = bus.open('inst-1')
    expect(ch.installationId).toBe('inst-1')
    expect(ch.closed).toBe(false)
  })

  it('open() is idempotent — returns the same channel for the same id', () => {
    const bus = new OpusBus()
    const a = bus.open('inst-1')
    const b = bus.open('inst-1')
    expect(a).toBe(b)
  })

  it('get() returns null for an unknown installation', () => {
    expect(new OpusBus().get('nope')).toBeNull()
  })

  it('close() emits session-end and removes the channel', () => {
    const bus = new OpusBus()
    const ch = bus.open('inst-1')
    const events: AudioChannelEvent[] = []
    ch.subscribe((e) => events.push(e))
    bus.close('inst-1', 'host-stopped')
    expect(events).toContainEqual({ kind: 'session-end', reason: 'host-stopped' })
    expect(bus.get('inst-1')).toBeNull()
    expect(ch.closed).toBe(true)
  })

  it('publish() on a closed channel is silently dropped', () => {
    const bus = new OpusBus()
    const ch = bus.open('inst-1')
    ch.close('done')
    const events: AudioChannelEvent[] = []
    ch.subscribe((e) => events.push(e))
    ch.publish({ kind: 'speaker-start', speakerId: 'u1' })
    expect(events).toHaveLength(0)
  })
})

describe('AudioChannel — pub/sub', () => {
  it('routes events to all subscribers', () => {
    const bus = new OpusBus()
    const ch = bus.open('inst-1')
    const a: AudioChannelEvent[] = []
    const b: AudioChannelEvent[] = []
    ch.subscribe((e) => a.push(e))
    ch.subscribe((e) => b.push(e))
    ch.publish({ kind: 'speaker-start', speakerId: 'u1' })
    ch.publish({ kind: 'speaker-data', speakerId: 'u1', opus: Buffer.from('x') })
    expect(a).toHaveLength(2)
    expect(b).toHaveLength(2)
  })

  it('unsubscribe() stops a subscriber from receiving further events', () => {
    const bus = new OpusBus()
    const ch = bus.open('inst-1')
    const events: AudioChannelEvent[] = []
    const unsub = ch.subscribe((e) => events.push(e))
    ch.publish({ kind: 'speaker-start', speakerId: 'u1' })
    unsub()
    ch.publish({ kind: 'speaker-end', speakerId: 'u1' })
    expect(events).toHaveLength(1)
  })
})
