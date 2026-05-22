/**
 * SessionRegistry — one-recording-per-guild lock.
 */
import { SessionRegistry, GuildConflictError } from '../../../src/recording/session-registry.js'
import type { SessionController } from '../../../src/recording/session-controller.js'

/** Minimal stand-in — the registry only touches recordingId + guildId. */
function fakeController(recordingId: string, guildId: string): SessionController {
  return { recordingId, guildId, voiceChannelId: 'vc' } as unknown as SessionController
}

describe('SessionRegistry', () => {
  it('reserve() blocks a second recording in the same guild', () => {
    const reg = new SessionRegistry()
    reg.reserve('rec-a', 'guild-1')
    expect(() => reg.reserve('rec-b', 'guild-1')).toThrow(GuildConflictError)
  })

  it('reserve() carries the conflicting recording id on the error', () => {
    const reg = new SessionRegistry()
    reg.reserve('rec-a', 'guild-1')
    try {
      reg.reserve('rec-b', 'guild-1')
      throw new Error('expected GuildConflictError')
    } catch (err) {
      expect(err).toBeInstanceOf(GuildConflictError)
      expect((err as GuildConflictError).conflictingRecordingId).toBe('rec-a')
    }
  })

  it('allows concurrent recordings in different guilds', () => {
    const reg = new SessionRegistry()
    reg.reserve('rec-a', 'guild-1')
    expect(() => reg.reserve('rec-b', 'guild-2')).not.toThrow()
  })

  it('re-reserving the same (recording, guild) pair is idempotent', () => {
    const reg = new SessionRegistry()
    reg.reserve('rec-a', 'guild-1')
    expect(() => reg.reserve('rec-a', 'guild-1')).not.toThrow()
  })

  it('release() frees the guild slot for a new recording', () => {
    const reg = new SessionRegistry()
    reg.reserve('rec-a', 'guild-1')
    reg.release('guild-1', 'rec-a')
    expect(() => reg.reserve('rec-b', 'guild-1')).not.toThrow()
  })

  it('commit() indexes the session by recording id and guild', () => {
    const reg = new SessionRegistry()
    reg.reserve('rec-a', 'guild-1')
    reg.commit(fakeController('rec-a', 'guild-1'))
    expect(reg.get('rec-a')?.recordingId).toBe('rec-a')
    expect(reg.getByGuild('guild-1')?.recordingId).toBe('rec-a')
    expect(reg.size).toBe(1)
  })

  it('remove() clears both indexes and frees the guild', () => {
    const reg = new SessionRegistry()
    reg.reserve('rec-a', 'guild-1')
    reg.commit(fakeController('rec-a', 'guild-1'))
    reg.remove('rec-a')
    expect(reg.get('rec-a')).toBeNull()
    expect(reg.getByGuild('guild-1')).toBeNull()
    expect(() => reg.reserve('rec-b', 'guild-1')).not.toThrow()
  })
})
