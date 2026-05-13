/**
 * Unit tests for SessionStore (gateway session state).
 */

import {
  SessionStore,
  GuildConflictError,
  SessionNotFoundError,
  type SessionRecord,
} from '../../../src/gateway/session-store.js'

function fakeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    installationId: 'inst-1',
    guildId: 'g-1',
    channelId: 'c-1',
    userId: 'u-1',
    containerId: 'docker-abc',
    containerName: 'cfg-resesh-worker-inst-1',
    hostPort: null,
    sessionToken: 'tok-xyz',
    status: 'ready',
    startedAt: Date.now(),
    endedAt: null,
    ...overrides,
  }
}

describe('SessionStore — reserve + conflict', () => {
  it('reserves a fresh guild slot', () => {
    const s = new SessionStore()
    expect(() => s.reserve('inst-1', 'g-1')).not.toThrow()
  })

  it('rejects a second reserve for the same guild', () => {
    const s = new SessionStore()
    s.reserve('inst-1', 'g-1')
    expect(() => s.reserve('inst-2', 'g-1')).toThrow(GuildConflictError)
    try {
      s.reserve('inst-2', 'g-1')
    } catch (e) {
      expect((e as GuildConflictError).conflictingInstallationId).toBe('inst-1')
    }
  })

  it('allows re-reserving the same guild+installation (idempotent)', () => {
    const s = new SessionStore()
    s.reserve('inst-1', 'g-1')
    expect(() => s.reserve('inst-1', 'g-1')).not.toThrow()
  })

  it('release() frees the reservation', () => {
    const s = new SessionStore()
    s.reserve('inst-1', 'g-1')
    s.release('g-1', 'inst-1')
    expect(() => s.reserve('inst-2', 'g-1')).not.toThrow()
  })

  it('release() is a no-op for a different installationId', () => {
    const s = new SessionStore()
    s.reserve('inst-1', 'g-1')
    s.release('g-1', 'wrong-inst')
    expect(() => s.reserve('inst-2', 'g-1')).toThrow(GuildConflictError)
  })
})

describe('SessionStore — commit + lookup + remove', () => {
  it('commit() makes the session findable by both indexes', () => {
    const s = new SessionStore()
    const rec = fakeRecord()
    s.commit(rec)
    expect(s.get('inst-1')).toEqual(rec)
    expect(s.getByGuild('g-1')).toEqual(rec)
    expect(s.has('inst-1')).toBe(true)
  })

  it('list() returns all active sessions', () => {
    const s = new SessionStore()
    s.commit(fakeRecord({ installationId: 'inst-1', guildId: 'g-1' }))
    s.commit(fakeRecord({ installationId: 'inst-2', guildId: 'g-2' }))
    expect(s.list()).toHaveLength(2)
  })

  it('markStopping() flips status to stopping', () => {
    const s = new SessionStore()
    s.commit(fakeRecord())
    const rec = s.markStopping('inst-1')
    expect(rec.status).toBe('stopping')
    expect(s.get('inst-1')!.status).toBe('stopping')
  })

  it('markStopping() throws for an unknown installation', () => {
    const s = new SessionStore()
    expect(() => s.markStopping('nope')).toThrow(SessionNotFoundError)
  })

  it('remove() clears both indexes', () => {
    const s = new SessionStore()
    s.commit(fakeRecord())
    s.remove('inst-1')
    expect(s.has('inst-1')).toBe(false)
    expect(s.getByGuild('g-1')).toBeNull()
    expect(() => s.reserve('inst-2', 'g-1')).not.toThrow()
  })

  it('remove() is idempotent', () => {
    const s = new SessionStore()
    s.remove('nonexistent')
    expect(s.list()).toHaveLength(0)
  })
})
