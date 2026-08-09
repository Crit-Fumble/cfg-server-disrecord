/**
 * FileConsentStore — self-host memory for "Yes, and remember".
 *
 * The store's whole job is to be durable and honest about it, so the cases
 * that matter are the unhappy ones: a missing file, a corrupt file, and two
 * people clicking at the same instant.
 */

import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileConsentStore } from '../../../src/consent/consent-store.js'

const GUILD = 'guild-1'
const CHANNEL = 'chan-1'

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
  dir = await mkdtemp(join(tmpdir(), 'disrecord-consent-store-'))
  path = join(dir, 'consent-store.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('FileConsentStore', () => {
  it('returns nothing on first run, without creating a file', async () => {
    const store = new FileConsentStore({ path, logger: makeLogger() })
    const loaded = await store.load(GUILD, CHANNEL)

    expect(loaded.size).toBe(0)
    await expect(readFile(path, 'utf-8')).rejects.toThrow()
  })

  it('round-trips a decision across store instances', async () => {
    const write = new FileConsentStore({ path, logger: makeLogger() })
    await write.set(GUILD, CHANNEL, 'user-1', 'opted-in')
    await write.set(GUILD, CHANNEL, 'user-2', 'opted-out')

    // A new instance is the next session — this is the thing that was broken.
    const read = new FileConsentStore({ path, logger: makeLogger() })
    const loaded = await read.load(GUILD, CHANNEL)

    expect(loaded.get('user-1')).toBe('opted-in')
    expect(loaded.get('user-2')).toBe('opted-out')
  })

  it('scopes decisions per channel', async () => {
    const store = new FileConsentStore({ path, logger: makeLogger() })
    await store.set(GUILD, CHANNEL, 'user-1', 'opted-in')

    expect((await store.load(GUILD, 'other-channel')).size).toBe(0)
    expect((await store.load('other-guild', CHANNEL)).size).toBe(0)
  })

  it('overwrites a user’s previous decision', async () => {
    const store = new FileConsentStore({ path, logger: makeLogger() })
    await store.set(GUILD, CHANNEL, 'user-1', 'opted-in')
    await store.set(GUILD, CHANNEL, 'user-1', 'opted-out')

    expect((await store.load(GUILD, CHANNEL)).get('user-1')).toBe('opted-out')
  })

  it('keeps every decision when several are written concurrently', async () => {
    const store = new FileConsentStore({ path, logger: makeLogger() })

    // Everyone clicks at once when the prompt lands. Unserialized
    // read-modify-write would drop all but the last.
    await Promise.all([
      store.set(GUILD, CHANNEL, 'user-1', 'opted-in'),
      store.set(GUILD, CHANNEL, 'user-2', 'opted-in'),
      store.set(GUILD, CHANNEL, 'user-3', 'opted-out'),
      store.set(GUILD, CHANNEL, 'user-4', 'opted-in'),
    ])

    const loaded = await store.load(GUILD, CHANNEL)
    expect(loaded.size).toBe(4)
    expect(loaded.get('user-3')).toBe('opted-out')
  })

  it('REFUSES to overwrite a corrupt file, and says so loudly', async () => {
    await writeFile(path, '{ this is not json', 'utf-8')
    const logger = makeLogger()
    const store = new FileConsentStore({ path, logger })

    expect((await store.load(GUILD, CHANNEL)).size).toBe(0)
    await store.set(GUILD, CHANNEL, 'user-1', 'opted-in')

    // The operator's file is still exactly as they left it — a failed parse
    // must never destroy a consent record.
    expect(await readFile(path, 'utf-8')).toBe('{ this is not json')
    expect((logger as unknown as { error: jest.Mock }).error).toHaveBeenCalled()
  })

  it('ignores unrecognised status values rather than trusting them', async () => {
    await writeFile(
      path,
      JSON.stringify({ version: 1, channels: { [`${GUILD}/${CHANNEL}`]: { 'user-1': 'maybe' } } }),
      'utf-8',
    )
    const store = new FileConsentStore({ path, logger: makeLogger() })

    expect((await store.load(GUILD, CHANNEL)).size).toBe(0)
  })

  it('creates the parent directory when it is missing', async () => {
    const nested = join(dir, 'a', 'b', 'consent-store.json')
    const store = new FileConsentStore({ path: nested, logger: makeLogger() })
    await store.set(GUILD, CHANNEL, 'user-1', 'opted-in')

    expect((await store.load(GUILD, CHANNEL)).get('user-1')).toBe('opted-in')
  })
})
