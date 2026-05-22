/**
 * SessionRegistry — in-process registry of active recording sessions.
 *
 * Ported from cfg-core-server's `services/disrecord/session-store.ts`,
 * trimmed to what the standalone container needs: no container ids, no
 * host ports — the container IS the process, so a session is just a live
 * {@link SessionController} keyed by recordingId, with a guildId → recordingId
 * index that enforces Discord's one-voice-connection-per-bot-per-guild rule.
 *
 * Self-host: the lock is per-process and authoritative. (CFG-hosted Phase 2
 * keeps core-server's cross-container `session-store` as the global authority.)
 */

import type { SessionController } from './session-controller.js'

export class GuildConflictError extends Error {
  constructor(public readonly conflictingRecordingId: string) {
    super(`Guild already has an active recording session: ${conflictingRecordingId}`)
    this.name = 'GuildConflictError'
  }
}

export class SessionNotFoundError extends Error {
  constructor(public readonly recordingId: string) {
    super(`No active recording session: ${recordingId}`)
    this.name = 'SessionNotFoundError'
  }
}

export class SessionRegistry {
  private readonly byRecording = new Map<string, SessionController>()
  private readonly byGuild = new Map<string, string>() // guildId → recordingId

  /**
   * Reserve a guild slot before joining voice. Throws {@link GuildConflictError}
   * when another session is already active in this guild. Pair with
   * `commit()` or `release()`.
   */
  reserve(recordingId: string, guildId: string): void {
    const existing = this.byGuild.get(guildId)
    if (existing && existing !== recordingId) {
      throw new GuildConflictError(existing)
    }
    this.byGuild.set(guildId, recordingId)
  }

  /** Register a live session after its controller has started. */
  commit(controller: SessionController): void {
    this.byRecording.set(controller.recordingId, controller)
    this.byGuild.set(controller.guildId, controller.recordingId)
  }

  /** Drop a guild reservation made by `reserve()` before `commit()`. */
  release(guildId: string, recordingId: string): void {
    if (this.byGuild.get(guildId) === recordingId) {
      this.byGuild.delete(guildId)
    }
  }

  /** Remove a session from both indexes. Idempotent. */
  remove(recordingId: string): void {
    const controller = this.byRecording.get(recordingId)
    if (!controller) return
    this.byRecording.delete(recordingId)
    if (this.byGuild.get(controller.guildId) === recordingId) {
      this.byGuild.delete(controller.guildId)
    }
  }

  get(recordingId: string): SessionController | null {
    return this.byRecording.get(recordingId) ?? null
  }

  getByGuild(guildId: string): SessionController | null {
    const recordingId = this.byGuild.get(guildId)
    if (!recordingId) return null
    return this.byRecording.get(recordingId) ?? null
  }

  list(): SessionController[] {
    return Array.from(this.byRecording.values())
  }

  has(recordingId: string): boolean {
    return this.byRecording.has(recordingId)
  }

  get size(): number {
    return this.byRecording.size
  }
}
