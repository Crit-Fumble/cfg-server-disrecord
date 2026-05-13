/**
 * SessionStore — in-memory registry of active recording sessions.
 *
 * Source of truth for "is this guild currently being recorded?" — used by
 * POST /v1/sessions to enforce Discord's one-voice-per-bot-per-guild rule
 * via 409 Conflict.
 *
 * Phase 0: in-memory only. Lost on gateway crash. Recovered on boot from
 * Docker container list (see worker-spawn.ts:reconcileFromDocker). Alpha-9
 * users + rare restarts make this acceptable; Phase 1 can move to Redis
 * or a small embedded store if the recovery window stops being acceptable.
 *
 * Two indexes maintained:
 *   - byGuild: enforces single active session per guild
 *   - byInstallation: O(1) lookup for DELETE /v1/sessions/:installationId
 */

export type SessionStatus = 'starting' | 'ready' | 'stopping' | 'failed'

export interface SessionRecord {
  installationId: string
  guildId: string
  channelId: string
  userId: string
  containerId: string
  containerName: string
  hostPort: number | null
  sessionToken: string
  status: SessionStatus
  startedAt: number // epoch ms
  endedAt: number | null
}

export class GuildConflictError extends Error {
  constructor(public readonly conflictingInstallationId: string) {
    super(`Guild already has an active recording session: ${conflictingInstallationId}`)
    this.name = 'GuildConflictError'
  }
}

export class SessionNotFoundError extends Error {
  constructor(public readonly installationId: string) {
    super(`No active session for installation: ${installationId}`)
    this.name = 'SessionNotFoundError'
  }
}

export class SessionStore {
  private byInstallation = new Map<string, SessionRecord>()
  private byGuild = new Map<string, string>() // guildId → installationId

  /**
   * Reserve a guild slot before joining voice. Throws GuildConflictError if
   * another session is active in this guild. Callers must call commit() or
   * release() after the lifecycle resolves.
   */
  reserve(installationId: string, guildId: string): void {
    const existing = this.byGuild.get(guildId)
    if (existing && existing !== installationId) {
      throw new GuildConflictError(existing)
    }
    this.byGuild.set(guildId, installationId)
  }

  /** Add or replace a session record. */
  commit(record: SessionRecord): void {
    this.byInstallation.set(record.installationId, record)
    this.byGuild.set(record.guildId, record.installationId)
  }

  /** Drop a guild reservation made by reserve() before commit. */
  release(guildId: string, installationId: string): void {
    if (this.byGuild.get(guildId) === installationId) {
      this.byGuild.delete(guildId)
    }
  }

  /** Mark a session as stopping (idempotent). Returns the record. */
  markStopping(installationId: string): SessionRecord {
    const record = this.byInstallation.get(installationId)
    if (!record) throw new SessionNotFoundError(installationId)
    record.status = 'stopping'
    return record
  }

  /** Remove a session from both indexes. Idempotent. */
  remove(installationId: string): void {
    const record = this.byInstallation.get(installationId)
    if (!record) return
    this.byInstallation.delete(installationId)
    if (this.byGuild.get(record.guildId) === installationId) {
      this.byGuild.delete(record.guildId)
    }
  }

  get(installationId: string): SessionRecord | null {
    return this.byInstallation.get(installationId) ?? null
  }

  getByGuild(guildId: string): SessionRecord | null {
    const installationId = this.byGuild.get(guildId)
    if (!installationId) return null
    return this.byInstallation.get(installationId) ?? null
  }

  list(): SessionRecord[] {
    return Array.from(this.byInstallation.values())
  }

  has(installationId: string): boolean {
    return this.byInstallation.has(installationId)
  }

  /** Test-only: clear all state. */
  __clearForTests(): void {
    this.byInstallation.clear()
    this.byGuild.clear()
  }
}
