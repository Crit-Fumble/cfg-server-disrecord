/**
 * DisRecord settings store — the container's own record of how it behaves.
 *
 * Three things are worth pinning here, and only one of them is the happy path:
 *
 *   1. `pickChannelSettings` is a SECURITY BOUNDARY. The document is
 *      downloadable, so anything a caller can plant is something they can read
 *      back. A spread instead of the allow-list would leak planted keys and
 *      carry a `__proto__` payload into the prototype chain.
 *   2. Precedence is FIELD BY FIELD. Object-level "scene wins" would mean
 *      setting one keyword on a channel silently discarded the world's thread
 *      target.
 *   3. Durability under the unhappy paths — missing file, corrupt file,
 *      simultaneous saves.
 */

import { chmod, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FileSettingsStore,
  effectiveSettings,
  pickChannelSettings,
  parseSettingsFile,
  emptySettingsFile,
  SettingsWriteError,
  CHANNEL_SETTINGS_KEYS,
  type GuildWorld,
} from '../../../src/settings/settings-store.js'

const GUILD = '100000000000000001'
const CHANNEL = '200000000000000002'
const OTHER_CHANNEL = '200000000000000003'

function makeLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(function (this: unknown) {
      return this
    }),
  } as never
}

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'disrecord-settings-'))
  path = join(dir, 'worlds.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('pickChannelSettings — the allow-list boundary', () => {
  it('copies known fields', () => {
    const out = pickChannelSettings({
      keywords: ['Keawe', 'Mumbley'],
      transcriptionEnabled: false,
      outputChannelId: '300000000000000004',
      threadNameTemplate: '{{voiceChannel}} - {{date}}',
    })
    expect(out).toEqual({
      keywords: ['Keawe', 'Mumbley'],
      transcriptionEnabled: false,
      outputChannelId: '300000000000000004',
      threadNameTemplate: '{{voiceChannel}} - {{date}}',
    })
  })

  it('DROPS planted credential-shaped keys', () => {
    const out = pickChannelSettings({
      keywords: ['ok'],
      discordToken: 'PLANTED-BOT-TOKEN',
      deepgramKey: 'PLANTED-DEEPGRAM-KEY',
      controlToken: 'PLANTED-CONTROL-TOKEN',
      coreServerToken: 'PLANTED-CORE-TOKEN',
    })
    // The document is downloadable — anything storable is readable back out.
    expect(JSON.stringify(out)).not.toContain('PLANTED')
    expect(Object.keys(out)).toEqual(['keywords'])
  })

  it('does not pollute the prototype, and does not carry __proto__ through', () => {
    const out = pickChannelSettings(JSON.parse('{"__proto__":{"polluted":"yes"},"keywords":["ok"]}'))
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect((Object.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined()
    // A spread would survive the two assertions above (it defines rather than
    // assigns, so `__proto__` lands as inert data) — this is the one that
    // actually distinguishes the allow-list from it.
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(false)
  })

  it('ignores inherited properties', () => {
    const parent = { keywords: ['inherited'] }
    const child = Object.create(parent) as Record<string, unknown>
    child.transcriptionEnabled = true
    // Only the child's OWN data is this object's data.
    expect(pickChannelSettings(child)).toEqual({ transcriptionEnabled: true })
  })

  it('rejects wrong-typed values rather than storing them', () => {
    const out = pickChannelSettings({
      keywords: 'not-an-array',
      transcriptionEnabled: 'yes',
      outputChannelId: 12345,
    })
    expect(out).toEqual({})
  })

  it('trims and drops empty keyword entries', () => {
    expect(pickChannelSettings({ keywords: ['  spaced  ', '', '   ', 'ok'] })).toEqual({
      keywords: ['spaced', 'ok'],
    })
  })

  it('KEEPS an empty array and an empty string — "explicitly none", not absent', () => {
    // Dropping these made it impossible for a scene to turn OFF something its
    // world sets: the scene's `[]` read as absent, and absent means inherit.
    expect(pickChannelSettings({ keywords: [], outputThreadId: '' })).toEqual({
      keywords: [],
      outputThreadId: '',
    })
  })

  it('treats null and undefined as absent, not as values', () => {
    expect(pickChannelSettings({ keywords: null, outputChannelId: undefined })).toEqual({})
  })

  it('handles non-object input', () => {
    expect(pickChannelSettings(null)).toEqual({})
    expect(pickChannelSettings('nope')).toEqual({})
  })

  it('every declared key is actually copyable — the list matches the interface', () => {
    const everyField: Record<string, unknown> = {
      keywords: ['a'],
      keyterms: ['b'],
      transcriptionEnabled: true,
      deepgramModel: 'nova-3',
      deepgramLanguage: 'en',
      outputChannelId: '1',
      outputThreadId: '2',
      threadNameTemplate: 't',
    }
    // Guards the "added a field to the interface, forgot the allow-list" case,
    // whose symptom is a setting that silently never saves.
    expect(Object.keys(pickChannelSettings(everyField)).sort()).toEqual([...CHANNEL_SETTINGS_KEYS].sort())
  })
})

describe('effectiveSettings — scene over world, field by field', () => {
  const world: GuildWorld = {
    defaults: { keywords: ['world-kw'], transcriptionEnabled: true, outputChannelId: '999' },
    scenes: { [CHANNEL]: { keywords: ['scene-kw'] } },
  }

  it('overrides only the fields the scene names', () => {
    expect(effectiveSettings(world, CHANNEL)).toEqual({
      keywords: ['scene-kw'],
      transcriptionEnabled: true,
      outputChannelId: '999',
    })
  })

  it('falls back to world defaults for an unconfigured scene', () => {
    expect(effectiveSettings(world, OTHER_CHANNEL)).toEqual({
      keywords: ['world-kw'],
      transcriptionEnabled: true,
      outputChannelId: '999',
    })
  })

  it('lets a scene override a boolean to false', () => {
    const w: GuildWorld = {
      defaults: { transcriptionEnabled: true },
      scenes: { [CHANNEL]: { transcriptionEnabled: false } },
    }
    // `false` is a value, not an absence — a truthiness check would lose it.
    expect(effectiveSettings(w, CHANNEL).transcriptionEnabled).toBe(false)
  })

  it('returns empty for an unknown world', () => {
    expect(effectiveSettings(undefined, CHANNEL)).toEqual({})
  })

  it('lets a scene clear an inherited list with an empty array', () => {
    const w: GuildWorld = {
      defaults: { keywords: ['world-kw'] },
      scenes: { [CHANNEL]: { keywords: [] } },
    }
    // The point of keeping `[]`: this channel wants NO keyword boosts, even
    // though its world configures some.
    expect(effectiveSettings(w, CHANNEL).keywords).toEqual([])
  })
})

describe('parseSettingsFile — untrusted input', () => {
  it('drops non-snowflake guild and channel keys', () => {
    const file = parseSettingsFile({
      worlds: {
        'not-a-snowflake': { defaults: {}, scenes: {} },
        [GUILD]: { defaults: {}, scenes: { bad: { keywords: ['x'] }, [CHANNEL]: { keywords: ['ok'] } } },
      },
    })
    expect(Object.keys(file.worlds)).toEqual([GUILD])
    expect(Object.keys(file.worlds[GUILD].scenes)).toEqual([CHANNEL])
  })

  it('keeps a valid grant and drops a malformed one', () => {
    const file = parseSettingsFile({
      worlds: {
        [GUILD]: {
          defaults: {},
          scenes: {},
          grants: [
            { scope: 'party', id: 'party-1', members: [{ discordUserId: '400000000000000005', seat: 'gm' }] },
            { scope: 'nonsense', id: 'x' },
            { scope: 'campaign' },
          ],
        },
      },
    })
    const grants = file.worlds[GUILD].grants
    expect(grants).toHaveLength(1)
    expect(grants?.[0]).toEqual({
      scope: 'party',
      id: 'party-1',
      members: [{ discordUserId: '400000000000000005', seat: 'gm' }],
    })
  })

  it('drops a grant member keyed by a platform id rather than a Discord id', () => {
    const file = parseSettingsFile({
      worlds: {
        [GUILD]: {
          defaults: {},
          scenes: {},
          // cuid, not a snowflake — a platform User.id must never land here.
          grants: [{ scope: 'party', id: 'p', members: [{ discordUserId: 'clx0a1b2c3', seat: 'gm' }] }],
        },
      },
    })
    expect(file.worlds[GUILD].grants?.[0].members).toBeUndefined()
  })

  it('returns an empty document for junk', () => {
    expect(parseSettingsFile(null)).toEqual(emptySettingsFile())
    expect(parseSettingsFile({ worlds: 'nope' })).toEqual(emptySettingsFile())
  })
})

describe('FileSettingsStore', () => {
  it('returns nothing on first run, without creating a file', async () => {
    const store = new FileSettingsStore({ path, logger: makeLogger() })
    expect((await store.load()).worlds).toEqual({})
    await expect(readFile(path, 'utf-8')).rejects.toThrow()
  })

  it('round-trips across store instances', async () => {
    const write = new FileSettingsStore({ path, logger: makeLogger() })
    await write.setWorldDefaults(GUILD, { transcriptionEnabled: false })
    await write.setScene(GUILD, CHANNEL, { keywords: ['Keawe'] })

    const read = new FileSettingsStore({ path, logger: makeLogger() })
    expect(await read.effective(GUILD, CHANNEL)).toEqual({
      keywords: ['Keawe'],
      transcriptionEnabled: false,
    })
  })

  it('clearScene makes the channel inherit again', async () => {
    const store = new FileSettingsStore({ path, logger: makeLogger() })
    await store.setWorldDefaults(GUILD, { keywords: ['world'] })
    await store.setScene(GUILD, CHANNEL, { keywords: ['scene'] })
    expect((await store.effective(GUILD, CHANNEL)).keywords).toEqual(['scene'])

    await store.clearScene(GUILD, CHANNEL)
    expect((await store.effective(GUILD, CHANNEL)).keywords).toEqual(['world'])
  })

  it('keeps every write when several land at once', async () => {
    const store = new FileSettingsStore({ path, logger: makeLogger() })
    await Promise.all([
      store.setScene(GUILD, CHANNEL, { keywords: ['a'] }),
      store.setScene(GUILD, OTHER_CHANNEL, { keywords: ['b'] }),
      store.setWorldDefaults(GUILD, { transcriptionEnabled: false }),
    ])

    // Unserialized read-modify-write would drop all but the last.
    const file = await store.load()
    expect(Object.keys(file.worlds[GUILD].scenes).sort()).toEqual([CHANNEL, OTHER_CHANNEL].sort())
    expect(file.worlds[GUILD].defaults.transcriptionEnabled).toBe(false)
  })

  it('never persists a planted credential', async () => {
    const store = new FileSettingsStore({ path, logger: makeLogger() })
    await store.setScene(GUILD, CHANNEL, {
      keywords: ['ok'],
      discordToken: 'PLANTED-BOT-TOKEN',
    } as never)

    expect(await readFile(path, 'utf-8')).not.toContain('PLANTED')
  })

  it('REFUSES to overwrite a corrupt file when the FIRST operation is a write', async () => {
    await writeFile(path, '{ not json at all', 'utf-8')
    const logger = makeLogger()
    const store = new FileSettingsStore({ path, logger })

    // ⚠️ No read first. That ordering is the whole test: the guard used to be
    // checked at the head of the write queue, but it is only ARMED by a read —
    // so the first operation of a process sailed past it, read an empty
    // document, and renamed that emptiness over the operator's config.
    // The original version of this test called load() here and passed while
    // that bug was live.
    await expect(store.setScene(GUILD, CHANNEL, { keywords: ['x'] })).rejects.toThrow(SettingsWriteError)

    expect(await readFile(path, 'utf-8')).toBe('{ not json at all')
    expect((logger as unknown as { error: jest.Mock }).error).toHaveBeenCalled()
  })

  it('REFUSES to overwrite a file that exists but cannot be read', async () => {
    await writeFile(path, '{"version":1,"worlds":{}}', 'utf-8')
    await chmod(path, 0o000)
    const store = new FileSettingsStore({ path, logger: makeLogger() })

    // Unreadable is the same danger as unparseable — an EACCES bind mount must
    // not be silently replaced with an empty document.
    await expect(store.setScene(GUILD, CHANNEL, { keywords: ['x'] })).rejects.toThrow(SettingsWriteError)

    await chmod(path, 0o600)
    expect(await readFile(path, 'utf-8')).toBe('{"version":1,"worlds":{}}')
  })

  it('an explicit import CAN replace a corrupt file — the repair path', async () => {
    await writeFile(path, '{ not json at all', 'utf-8')
    const store = new FileSettingsStore({ path, logger: makeLogger() })

    // Refusing this too would leave an operator whose file got truncated with
    // no way back except deleting it by hand.
    await store.replaceAll({
      version: 1,
      worlds: { [GUILD]: { defaults: { keywords: ['restored'] }, scenes: {} } },
    })
    expect((await store.world(GUILD))?.defaults.keywords).toEqual(['restored'])

    // ...and ordinary writes work again afterwards, rather than staying locked
    // until the container restarts.
    await store.setScene(GUILD, CHANNEL, { keywords: ['after'] })
    expect((await store.effective(GUILD, CHANNEL)).keywords).toEqual(['after'])
  })

  it('surfaces an I/O failure instead of reporting success', async () => {
    // A directory where the file should be: open() fails with EISDIR.
    const store = new FileSettingsStore({ path: dir, logger: makeLogger() })
    await expect(store.setScene(GUILD, CHANNEL, { keywords: ['x'] })).rejects.toThrow(SettingsWriteError)
  })

  it('replaceAll normalizes the uploaded document', async () => {
    const store = new FileSettingsStore({ path, logger: makeLogger() })
    await store.replaceAll({
      version: 1,
      worlds: {
        [GUILD]: {
          defaults: { keywords: ['kept'], discordToken: 'PLANTED' },
          scenes: {},
        },
      },
    } as never)

    expect(await readFile(path, 'utf-8')).not.toContain('PLANTED')
    expect((await store.world(GUILD))?.defaults.keywords).toEqual(['kept'])
  })

  it('creates the parent directory when it is missing', async () => {
    const nested = join(dir, 'a', 'b', 'worlds.json')
    const store = new FileSettingsStore({ path: nested, logger: makeLogger() })
    await store.setScene(GUILD, CHANNEL, { keywords: ['ok'] })

    expect((await store.effective(GUILD, CHANNEL)).keywords).toEqual(['ok'])
  })
})
