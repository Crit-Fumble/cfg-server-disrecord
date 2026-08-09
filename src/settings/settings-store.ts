/**
 * DisRecord settings — the container's own record of how it should behave.
 *
 * ## Why this lives here and not in the platform database
 *
 * A skill server should remember the data it needs to FUNCTION. Per-channel
 * keywords, transcription defaults and thread targets are operational config:
 * the container is the only thing that acts on them, so keeping them in
 * core-server's Postgres bloated the platform DB and made core load-bearing
 * for a surface that should stand alone. Self-host had no equivalent at all —
 * one global env config and nothing per channel.
 *
 * The shape follows the house pattern rather than inventing one. FoundryVTT's
 * world config lives on the installation's volume and core reads it straight
 * off disk with the container stopped (`foundry-worlds.ts` in cfg-core-server),
 * and the platform states the rule in schema for `InstallationResource`:
 * "Filesystem always wins on conflict" — DB rows are a cache the next sync
 * rebuilds from disk. This file is DisRecord's equivalent of `world.json`.
 *
 * ## Foundry-shaped domain model (owner decision)
 *
 *   Discord guild         ≈ Foundry world
 *   Discord voice channel ≈ Foundry scene
 *
 * A scene inherits its world's defaults field-by-field and overrides what it
 * names. See {@link effectiveSettings}.
 *
 * ## ⚠️ The invariant that makes this safe to hand to a user
 *
 * THIS DOCUMENT CONTAINS NO CREDENTIALS AND NO PLATFORM IDENTIFIERS.
 *
 * It is downloadable and uploadable, so it must stay comfortable in the open:
 *   - Credentials live in process env and are unreachable from any route. The
 *     hosted bot token is SHARED across every CFG user's container, so one leak
 *     is a platform-wide compromise; the platform Deepgram key never enters the
 *     container at all (short-lived grant tokens instead). A user's own
 *     Deepgram key stays encrypted in core's DB — a config file people email
 *     to each other is the wrong home for a billing credential.
 *   - Identifiers are Discord snowflakes only, never a platform `User.id`.
 *     That is what lets a self-hoster with no CFG account use the same file,
 *     and what keeps an export from carrying platform data off-platform.
 *
 * {@link pickChannelSettings} is the enforcement point: an explicit allow-list,
 * never an object spread. Keep it that way — a spread would let a caller plant
 * a `discordToken` key and have it echoed straight back out of the export.
 *
 * ## Note for the next reader: yes, this duplicates `consent/consent-store.ts`
 *
 * Deliberately. The atomic write, the serialized queue and the
 * refuse-to-overwrite-a-corrupt-file rule are ~80 lines that took real
 * incidents to get right, and they are copied rather than extracted because
 * extracting at the SECOND use is guessing where the seam goes. Two stores is
 * fine; a wrong abstraction is not. **Extract a shared JSON document store at
 * the third one, not this one.**
 *
 * Consent stays in its own separate file for a different reason: it is a legal
 * record about third parties and must never ride along in a user-downloadable
 * settings export.
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Logger } from '../logger.js'

/**
 * Operational config for one voice channel — what the container needs to run a
 * recording. Every field optional: absent means "inherit, or use the global
 * env default".
 *
 * ⚠️ Adding a field here means adding it to {@link pickChannelSettings} too, or
 * it will be silently dropped on write. That is the intended failure direction:
 * a forgotten field is a missing feature, whereas an open spread is a leak.
 */
export interface ChannelSettings {
  /** Deepgram keyword boosts. An array — the CSV form was a textarea artifact. */
  keywords?: string[]
  /** Deepgram nova-3 keyterms. Separate from `keywords`, as SessionPolicy already treats them. */
  keyterms?: string[]
  /** Whether live transcription runs. Absent ⇒ the container's global default. */
  transcriptionEnabled?: boolean
  /** Deepgram model override, e.g. `nova-3`. */
  deepgramModel?: string
  /** Deepgram language override, e.g. `en`. */
  deepgramLanguage?: string
  /** Text channel the recording thread is created under. Discord snowflake. */
  outputChannelId?: string
  /** Existing thread to reuse instead of creating one. Discord snowflake. */
  outputThreadId?: string
  /** Thread-name template, e.g. `{{voiceChannel}} - {{date}} - {{kind}}`. */
  threadNameTemplate?: string
}

/** Seat a granted member holds. Mirrors the platform's campaign participant roles. */
export type GrantSeat = 'gm' | 'assistant_gm' | 'player'

/**
 * OPTIONAL platform integration: a party- or campaign-scoped access grant.
 *
 * Absent in the default minimal setup — a self-hoster never needs one. When a
 * CFG party or campaign is bound, core projects its membership down into this
 * shape so ReSesh can read party/campaign access from DisRecord directly
 * instead of from the platform.
 *
 * ⚠️ Members are keyed by DISCORD id, not platform `User.id`. A self-hoster has
 * Discord ids and no CFG accounts, and the file must not carry platform data.
 */
export interface AccessGrant {
  scope: 'party' | 'campaign'
  /** Opaque to DisRecord — meaningful only to whoever issued the grant. */
  id: string
  /** Human label, so a downloaded file reads. */
  label?: string
  /** Voice channels covered. Absent or empty ⇒ the whole world. */
  scenes?: string[]
  members?: Array<{ discordUserId: string; seat: GrantSeat }>
}

/** One Discord guild — a "world", in the Foundry shape. */
export interface GuildWorld {
  /** Cosmetic cache so a downloaded file is readable. The gateway is authoritative. */
  name?: string
  /** World-level defaults every scene inherits unless it overrides them. */
  defaults: ChannelSettings
  /** Per-voice-channel overrides — "scenes". */
  scenes: Record<string, ChannelSettings>
  /** Optional platform integration; see {@link AccessGrant}. */
  grants?: AccessGrant[]
}

/** On-disk root. One document per DisRecord instance. */
export interface DisrecordSettingsFile {
  version: 1
  worlds: Record<string, GuildWorld>
}

/** A fresh, empty document. */
export function emptySettingsFile(): DisrecordSettingsFile {
  return { version: 1, worlds: Object.create(null) as Record<string, GuildWorld> }
}

/**
 * Keys `pickChannelSettings` copies. Declared as data so a test can assert the
 * allow-list matches the interface rather than trusting they were kept in step.
 */
export const CHANNEL_SETTINGS_KEYS = [
  'keywords',
  'keyterms',
  'transcriptionEnabled',
  'deepgramModel',
  'deepgramLanguage',
  'outputChannelId',
  'outputThreadId',
  'threadNameTemplate',
] as const

/**
 * Copy ONLY known settings fields off untrusted input.
 *
 * ⚠️ THE ALLOW-LIST IS A SECURITY BOUNDARY, NOT TIDINESS. Never replace this
 * with a spread or `Object.assign`. Input reaches here from an HTTP body and
 * from an uploaded file, and the result is served back out of the export, so
 * either would let anyone plant `{"discordToken":"…"}` and read it straight
 * back.
 *
 * The two differ in a second way worth knowing before reaching for one:
 * `{...src}` defines own properties, so a `__proto__` key lands as inert data —
 * but `Object.assign` ASSIGNS, which trips the `__proto__` setter and pollutes
 * the prototype chain. Copying named keys onto a null-prototype object avoids
 * both by construction and needs no such reasoning.
 */
export function pickChannelSettings(input: unknown): ChannelSettings {
  const out = Object.create(null) as Record<string, unknown>
  if (!input || typeof input !== 'object') return out as ChannelSettings
  const src = input as Record<string, unknown>

  for (const key of CHANNEL_SETTINGS_KEYS) {
    // Own properties only — an inherited value is not this object's data.
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue
    const value = src[key]
    if (value === undefined || value === null) continue

    switch (key) {
      case 'keywords':
      case 'keyterms':
        if (Array.isArray(value)) {
          const strings = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
          if (strings.length > 0) out[key] = strings.map((s) => s.trim())
        }
        break
      case 'transcriptionEnabled':
        if (typeof value === 'boolean') out[key] = value
        break
      default:
        if (typeof value === 'string' && value.length > 0) out[key] = value
        break
    }
  }
  return out as ChannelSettings
}

/**
 * Resolve what actually applies to one voice channel: the scene's override
 * layered over the world's defaults, FIELD BY FIELD.
 *
 * Field-by-field matters — object-level "scene wins if present" would mean
 * setting one keyword on a channel silently discarded the world's thread
 * target. Pure and I/O-free so the precedence rule is unit-testable on its own.
 */
export function effectiveSettings(
  world: GuildWorld | undefined,
  voiceChannelId: string,
): ChannelSettings {
  if (!world) return Object.create(null) as ChannelSettings
  const defaults = pickChannelSettings(world.defaults)
  const scene = pickChannelSettings(world.scenes?.[voiceChannelId])
  const out = Object.create(null) as Record<string, unknown>
  for (const key of CHANNEL_SETTINGS_KEYS) {
    const sceneValue = (scene as Record<string, unknown>)[key]
    const defaultValue = (defaults as Record<string, unknown>)[key]
    const resolved = sceneValue !== undefined ? sceneValue : defaultValue
    if (resolved !== undefined) out[key] = resolved
  }
  return out as ChannelSettings
}

/** Normalize one world off untrusted input, dropping anything unrecognised. */
function pickWorld(input: unknown): GuildWorld | null {
  if (!input || typeof input !== 'object') return null
  const src = input as Record<string, unknown>
  const world: GuildWorld = {
    defaults: pickChannelSettings(src.defaults),
    scenes: Object.create(null) as Record<string, ChannelSettings>,
  }
  if (typeof src.name === 'string' && src.name.length > 0) world.name = src.name

  if (src.scenes && typeof src.scenes === 'object') {
    for (const [channelId, value] of Object.entries(src.scenes as Record<string, unknown>)) {
      if (!isSnowflake(channelId)) continue
      world.scenes[channelId] = pickChannelSettings(value)
    }
  }

  const grants = pickGrants(src.grants)
  if (grants.length > 0) world.grants = grants
  return world
}

function pickGrants(input: unknown): AccessGrant[] {
  if (!Array.isArray(input)) return []
  const out: AccessGrant[] = []
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const src = raw as Record<string, unknown>
    if (src.scope !== 'party' && src.scope !== 'campaign') continue
    if (typeof src.id !== 'string' || src.id.length === 0) continue

    const grant: AccessGrant = { scope: src.scope, id: src.id }
    if (typeof src.label === 'string' && src.label.length > 0) grant.label = src.label
    if (Array.isArray(src.scenes)) {
      const scenes = src.scenes.filter((s): s is string => typeof s === 'string' && isSnowflake(s))
      if (scenes.length > 0) grant.scenes = scenes
    }
    if (Array.isArray(src.members)) {
      const members: AccessGrant['members'] = []
      for (const m of src.members) {
        if (!m || typeof m !== 'object') continue
        const member = m as Record<string, unknown>
        const seat = member.seat
        if (typeof member.discordUserId !== 'string' || !isSnowflake(member.discordUserId)) continue
        if (seat !== 'gm' && seat !== 'assistant_gm' && seat !== 'player') continue
        members.push({ discordUserId: member.discordUserId, seat })
      }
      if (members.length > 0) grant.members = members
    }
    out.push(grant)
  }
  return out
}

/** Discord snowflake shape. Keys come from untrusted input, so validate them. */
function isSnowflake(value: string): boolean {
  return /^\d{1,20}$/.test(value)
}

/**
 * Normalize a whole document off untrusted input — the import path, and the
 * parse path for a file someone hand-edited. Unknown keys are dropped, never
 * carried through.
 */
export function parseSettingsFile(input: unknown): DisrecordSettingsFile {
  const file = emptySettingsFile()
  if (!input || typeof input !== 'object') return file
  const src = input as Record<string, unknown>
  if (!src.worlds || typeof src.worlds !== 'object') return file

  for (const [guildId, value] of Object.entries(src.worlds as Record<string, unknown>)) {
    if (!isSnowflake(guildId)) continue
    const world = pickWorld(value)
    if (world) file.worlds[guildId] = world
  }
  return file
}

export interface SettingsStore {
  /** The whole document. */
  load(): Promise<DisrecordSettingsFile>
  /** One guild's world, or undefined when nothing is configured for it. */
  world(guildId: string): Promise<GuildWorld | undefined>
  /** What actually applies to a voice channel — scene over world defaults. */
  effective(guildId: string, voiceChannelId: string): Promise<ChannelSettings>
  /** Replace a world's defaults. */
  setWorldDefaults(guildId: string, defaults: ChannelSettings): Promise<void>
  /** Replace one scene's override. */
  setScene(guildId: string, voiceChannelId: string, settings: ChannelSettings): Promise<void>
  /** Clear one scene's override so it inherits the world's defaults. */
  clearScene(guildId: string, voiceChannelId: string): Promise<void>
  /** Replace a world's access grants wholesale. */
  setGrants(guildId: string, grants: AccessGrant[]): Promise<void>
  /** Replace the entire document — the upload path. */
  replaceAll(file: DisrecordSettingsFile): Promise<void>
}

/**
 * JSON-file settings store.
 *
 * One file, not a directory per guild: a realistic instance is a handful of
 * guilds with a few configured channels each — well under 100 KB — and a single
 * file makes "download my settings" a `readFile` instead of a zip dependency.
 * If this ever passes ~1 MB, or gains a per-channel blob field, THEN split per
 * guild. Not before.
 */
export class FileSettingsStore implements SettingsStore {
  private readonly path: string
  private readonly logger: Logger
  /** Write queue — every mutation chains onto the previous one. */
  private tail: Promise<void> = Promise.resolve()
  /**
   * Set when the file exists but could not be parsed. Writes are then refused
   * for the rest of the process's life, so a corrupt file is never overwritten
   * and the operator's configuration is not destroyed by a bad parse. The
   * container still runs; it just falls back to env defaults.
   */
  private readOnlyBecauseCorrupt = false

  constructor(params: { path: string; logger: Logger }) {
    this.path = params.path
    this.logger = params.logger
  }

  async load(): Promise<DisrecordSettingsFile> {
    return this.read()
  }

  async world(guildId: string): Promise<GuildWorld | undefined> {
    return (await this.read()).worlds[guildId]
  }

  async effective(guildId: string, voiceChannelId: string): Promise<ChannelSettings> {
    return effectiveSettings(await this.world(guildId), voiceChannelId)
  }

  async setWorldDefaults(guildId: string, defaults: ChannelSettings): Promise<void> {
    return this.mutate(guildId, (world) => {
      world.defaults = pickChannelSettings(defaults)
    })
  }

  async setScene(guildId: string, voiceChannelId: string, settings: ChannelSettings): Promise<void> {
    return this.mutate(guildId, (world) => {
      world.scenes[voiceChannelId] = pickChannelSettings(settings)
    })
  }

  async clearScene(guildId: string, voiceChannelId: string): Promise<void> {
    return this.mutate(guildId, (world) => {
      delete world.scenes[voiceChannelId]
    })
  }

  async setGrants(guildId: string, grants: AccessGrant[]): Promise<void> {
    return this.mutate(guildId, (world) => {
      const picked = pickGrants(grants)
      if (picked.length > 0) world.grants = picked
      else delete world.grants
    })
  }

  async replaceAll(file: DisrecordSettingsFile): Promise<void> {
    return this.enqueue(async () => {
      // Normalize rather than trusting the caller — this is the upload path.
      await this.write(parseSettingsFile(file))
    })
  }

  /** Read-modify-write one world, serialized against every other mutation. */
  private mutate(guildId: string, apply: (world: GuildWorld) => void): Promise<void> {
    return this.enqueue(async () => {
      const file = await this.read()
      const world = file.worlds[guildId] ?? {
        defaults: Object.create(null) as ChannelSettings,
        scenes: Object.create(null) as Record<string, ChannelSettings>,
      }
      apply(world)
      file.worlds[guildId] = world
      await this.write(file)
    })
  }

  /**
   * Chain a mutation onto the write queue. Several people can save at the same
   * instant; an unserialized read-modify-write would drop all but the last.
   */
  private enqueue(work: () => Promise<void>): Promise<void> {
    const run = this.tail.then(async () => {
      if (this.readOnlyBecauseCorrupt) return
      await work()
    })
    // Keep the chain alive even if this write threw — one failure must not
    // wedge every later save.
    this.tail = run.catch(() => undefined)
    return run
  }

  private async read(): Promise<DisrecordSettingsFile> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf-8')
    } catch (err) {
      // Missing file is the normal first-run state, not a problem.
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return emptySettingsFile()
      this.logger.warn({ err, path: this.path }, 'settings store unreadable — continuing with env defaults')
      return emptySettingsFile()
    }
    try {
      return parseSettingsFile(JSON.parse(raw))
    } catch (err) {
      // Loud, and write-disabled: overwriting would destroy configuration we
      // simply failed to read.
      this.readOnlyBecauseCorrupt = true
      this.logger.error(
        { err, path: this.path },
        'settings store is corrupt — REFUSING to write it. Running on env defaults this run; ' +
          'fix or remove the file to restore persistence.',
      )
      return emptySettingsFile()
    }
  }

  private async write(file: DisrecordSettingsFile): Promise<void> {
    const tmp = `${this.path}.tmp`
    try {
      await mkdir(dirname(this.path), { recursive: true })
      await writeFile(tmp, JSON.stringify(file, null, 2), 'utf-8')
      await rename(tmp, this.path)
    } catch (err) {
      // Best-effort: the running session already has what it needs in memory,
      // only the memory across restarts is lost.
      this.logger.warn({ err, path: this.path }, 'settings store write failed — change applies to this run only')
    }
  }
}
