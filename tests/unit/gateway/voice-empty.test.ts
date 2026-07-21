import { VoiceEmptyTracker } from '../../../src/gateway/voice-empty.js'

const SEC = 1_000

describe('VoiceEmptyTracker', () => {
  it('does not fire while humans are present', () => {
    const t = new VoiceEmptyTracker({ graceMs: 60 * SEC })
    t.setMembers(['u1', 'u2'], 0)
    expect(t.dueAt()).toBeNull()
    expect(t.isDue(10 * 60 * SEC)).toBe(false)
  })

  it('fires once the channel has been empty for the full grace period', () => {
    const t = new VoiceEmptyTracker({ graceMs: 60 * SEC })
    t.setMembers(['u1'], 0)
    t.setMembers([], 10 * SEC) // everyone left at t=10s
    expect(t.dueAt()).toBe(70 * SEC)
    expect(t.isDue(69 * SEC)).toBe(false)
    expect(t.isDue(70 * SEC)).toBe(true)
  })

  it('cancels when someone rejoins inside the grace window — the drop-and-hop-back case', () => {
    // This is the whole point of the grace: a brief disconnect must not end
    // the session out from under people who are coming straight back.
    const t = new VoiceEmptyTracker({ graceMs: 60 * SEC })
    t.setMembers(['u1'], 0)
    t.setMembers([], 10 * SEC)
    t.setMembers(['u1'], 40 * SEC) // back after 30s
    expect(t.dueAt()).toBeNull()
    expect(t.isDue(10 * 60 * SEC)).toBe(false)
  })

  it('restarts the full grace after a rejoin-then-leave', () => {
    const t = new VoiceEmptyTracker({ graceMs: 60 * SEC })
    t.setMembers(['u1'], 0)
    t.setMembers([], 10 * SEC)
    t.setMembers(['u1'], 40 * SEC)
    t.setMembers([], 50 * SEC) // left again at t=50s
    expect(t.dueAt()).toBe(110 * SEC) // NOT 70s — the clock restarts
    expect(t.isDue(109 * SEC)).toBe(false)
    expect(t.isDue(110 * SEC)).toBe(true)
  })

  it('treats a single remaining human as NOT empty', () => {
    // core-server's cron uses `humanCount >= 2`, so one person alone reads as
    // empty and gets the session paused. Solo prep is legitimate: only a
    // genuinely empty channel counts here.
    const t = new VoiceEmptyTracker({ graceMs: 60 * SEC })
    t.setMembers(['u1'], 0)
    expect(t.isDue(10 * 60 * SEC)).toBe(false)
  })

  it('ignores repeated empty reports without restarting the clock', () => {
    // voiceStateUpdate fires for mute/deafen/video too; a redundant "still
    // empty" must not push the deadline out forever.
    const t = new VoiceEmptyTracker({ graceMs: 60 * SEC })
    t.setMembers([], 0)
    t.setMembers([], 20 * SEC)
    t.setMembers([], 40 * SEC)
    expect(t.dueAt()).toBe(60 * SEC)
    expect(t.isDue(60 * SEC)).toBe(true)
  })

  it('starts empty when a recording begins in a channel with nobody in it', () => {
    const t = new VoiceEmptyTracker({ graceMs: 60 * SEC })
    t.setMembers([], 5 * SEC)
    expect(t.dueAt()).toBe(65 * SEC)
  })

  it('never counts bots — only the humans passed in', () => {
    // Caller filters bots; the tracker is deliberately dumb about identity so
    // the bot-exclusion rule lives in exactly one place.
    const t = new VoiceEmptyTracker({ graceMs: 60 * SEC })
    t.setMembers([], 0)
    expect(t.isDue(60 * SEC)).toBe(true)
  })

  it('stops reporting due once reset', () => {
    const t = new VoiceEmptyTracker({ graceMs: 60 * SEC })
    t.setMembers([], 0)
    expect(t.isDue(60 * SEC)).toBe(true)
    t.reset()
    expect(t.dueAt()).toBeNull()
    expect(t.isDue(10 * 60 * SEC)).toBe(false)
  })
})
