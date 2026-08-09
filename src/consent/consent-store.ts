/**
 * Persistent consent store — self-host only.
 *
 * ## Why this exists
 *
 * The consent prompt offers "🔁 Yes, and remember — voice is captured for this
 * session AND future sessions in this channel." CFG-hosted honours that:
 * Discord routes the click to core-server's webhook, which writes a
 * channel-scoped `PersistentRecordingConsent` row.
 *
 * Self-host has no webhook and no database, so `consent_remember` collapsed to
 * a plain one-session consent and the "remember" half silently did nothing.
 * The button promised something the container could not deliver. This is the
 * smallest thing that makes it true.
 *
 * ## Scope
 *
 * Deliberately ONE concern: a channel-scoped opt-in / opt-out per Discord user,
 * which is exactly the scope core uses for this surface. Not a general settings
 * store — per-channel keywords, auto-start and thread templates stay
 * core-side/env-driven until something actually needs them here.
 *
 * ⚠️ Never constructed CFG-hosted. Core owns persistent consent there, and two
 * writers would mean reconciling them — see the session controller's `cfg`
 * branch, the same split `ConsentSync` already uses.
 *
 * ## Semantics — mirrored from core's `handleConsentButton`
 *
 *   - "Skip my voice" (decline)      → ALWAYS persists an opt-OUT, so the next
 *                                      session in this channel doesn't re-prompt.
 *   - "Yes, and remember"            → persists an opt-IN.
 *   - "Yes, this time only"          → persists NOTHING; they get re-prompted.
 *
 * Divergence here is worse than absence: a self-hoster and a CFG user reading
 * the same button label must get the same behaviour.
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Logger } from '../logger.js'

export type PersistentConsentStatus = 'opted-in' | 'opted-out'

/** On-disk shape. `version` is here so a future migration has something to read. */
interface ConsentFile {
  version: 1
  /** `"<guildId>/<voiceChannelId>"` → discordUserId → status. */
  channels: Record<string, Record<string, PersistentConsentStatus>>
}

const EMPTY: ConsentFile = { version: 1, channels: {} }

function channelKey(guildId: string, voiceChannelId: string): string {
  return `${guildId}/${voiceChannelId}`
}

export interface ConsentStore {
  /** Stored decisions for one voice channel. Empty map when nothing is stored. */
  load(guildId: string, voiceChannelId: string): Promise<Map<string, PersistentConsentStatus>>
  /** Persist one user's channel-level decision. */
  set(
    guildId: string,
    voiceChannelId: string,
    discordUserId: string,
    status: PersistentConsentStatus,
  ): Promise<void>
}

/**
 * JSON-file store. One small file; a voice channel has at most ~99 members and
 * a self-host instance a handful of channels, so there is nothing here that
 * wants a database.
 *
 * Writes are atomic (temp file + rename) and serialized through a promise
 * chain, because several people can click their buttons at the same instant
 * and a read-modify-write race would drop a decision.
 */
export class FileConsentStore implements ConsentStore {
  private readonly path: string
  private readonly logger: Logger
  /** Write queue — every mutation chains onto the previous one. */
  private tail: Promise<void> = Promise.resolve()
  /**
   * Set when the file exists but could not be parsed. We then refuse to WRITE
   * for the rest of the process's life, so a corrupt file is never overwritten
   * and the operator's consent record is not destroyed by a bad parse. The
   * session still runs; decisions just live in memory as they did before.
   */
  private readOnlyBecauseCorrupt = false

  constructor(params: { path: string; logger: Logger }) {
    this.path = params.path
    this.logger = params.logger
  }

  async load(guildId: string, voiceChannelId: string): Promise<Map<string, PersistentConsentStatus>> {
    const file = await this.read()
    const out = new Map<string, PersistentConsentStatus>()
    for (const [userId, status] of Object.entries(file.channels[channelKey(guildId, voiceChannelId)] ?? {})) {
      if (status === 'opted-in' || status === 'opted-out') out.set(userId, status)
    }
    return out
  }

  async set(
    guildId: string,
    voiceChannelId: string,
    discordUserId: string,
    status: PersistentConsentStatus,
  ): Promise<void> {
    const run = this.tail.then(async () => {
      if (this.readOnlyBecauseCorrupt) return
      const file = await this.read()
      const key = channelKey(guildId, voiceChannelId)
      file.channels[key] = { ...(file.channels[key] ?? {}), [discordUserId]: status }
      await this.write(file)
    })
    // Keep the chain alive even if this write threw — one failure must not
    // wedge every later decision.
    this.tail = run.catch(() => undefined)
    return run
  }

  private async read(): Promise<ConsentFile> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf-8')
    } catch (err) {
      // Missing file is the normal first-run state, not a problem.
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { ...EMPTY, channels: {} }
      this.logger.warn({ err, path: this.path }, 'consent store unreadable — continuing without stored consent')
      return { ...EMPTY, channels: {} }
    }
    try {
      const parsed = JSON.parse(raw) as Partial<ConsentFile>
      if (!parsed || typeof parsed !== 'object' || typeof parsed.channels !== 'object' || !parsed.channels) {
        throw new Error('unexpected shape')
      }
      return { version: 1, channels: parsed.channels as ConsentFile['channels'] }
    } catch (err) {
      // Loud, and write-disabled: overwriting would destroy a consent record
      // we simply failed to read.
      this.readOnlyBecauseCorrupt = true
      this.logger.error(
        { err, path: this.path },
        'consent store is corrupt — REFUSING to write it. Stored consent is ignored this run; ' +
          'fix or remove the file to restore persistence.',
      )
      return { ...EMPTY, channels: {} }
    }
  }

  private async write(file: ConsentFile): Promise<void> {
    const tmp = `${this.path}.tmp`
    try {
      await mkdir(dirname(this.path), { recursive: true })
      await writeFile(tmp, JSON.stringify(file, null, 2), 'utf-8')
      await rename(tmp, this.path)
    } catch (err) {
      // Best-effort, like every other side channel here: the in-session
      // decision already took effect, only its memory across sessions is lost.
      this.logger.warn({ err, path: this.path }, 'consent store write failed — decision applies to this session only')
    }
  }
}
