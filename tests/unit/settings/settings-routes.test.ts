/**
 * Settings control API — routes, the single-writer gate, and the credential
 * guard.
 *
 * The last of those is the reason this file matters. The settings document is
 * downloadable, and the container holds credentials that must never reach a
 * response: the CFG-hosted bot token is SHARED across every user's container,
 * so one leak is a platform-wide compromise, not a single-user one.
 */

import Fastify, { type FastifyInstance } from 'fastify'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerSettingsRoutes } from '../../../src/settings/settings-routes.js'
import { FileSettingsStore } from '../../../src/settings/settings-store.js'

const GUILD = '100000000000000001'
const CHANNEL = '200000000000000002'

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

async function build(
  readOnly = false,
): Promise<{ app: FastifyInstance; store: FileSettingsStore; routes: Array<{ method: string; url: string }> }> {
  const store = new FileSettingsStore({ path, logger: makeLogger() })
  const app = Fastify({ logger: false })
  const routes: Array<{ method: string; url: string }> = []
  // Registered BEFORE the routes, so it sees every one of them.
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method]
    for (const method of methods) routes.push({ method, url: route.url })
  })
  registerSettingsRoutes(app, store, { readOnly, logger: makeLogger() })
  await app.ready()
  return { app, store, routes }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'disrecord-settings-routes-'))
  path = join(dir, 'worlds.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('settings routes — reads and writes', () => {
  it('lists nothing before anything is configured', async () => {
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/v1/worlds' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ worlds: {} })
  })

  it('404s an unconfigured world but still resolves its scenes', async () => {
    const { app } = await build()
    expect((await app.inject({ method: 'GET', url: `/v1/worlds/${GUILD}` })).statusCode).toBe(404)

    // A scene read must NOT 404 — "nothing configured" is a legitimate answer
    // the settings UI renders as empty defaults.
    const scene = await app.inject({ method: 'GET', url: `/v1/worlds/${GUILD}/scenes/${CHANNEL}` })
    expect(scene.statusCode).toBe(200)
    expect(scene.json()).toEqual({ effective: {}, override: {} })
  })

  it('round-trips world defaults', async () => {
    const { app } = await build()
    const put = await app.inject({
      method: 'PUT',
      url: `/v1/worlds/${GUILD}/defaults`,
      payload: { keywords: ['Keawe'], transcriptionEnabled: false },
    })
    expect(put.statusCode).toBe(200)

    const get = await app.inject({ method: 'GET', url: `/v1/worlds/${GUILD}` })
    expect(get.json().defaults).toEqual({ keywords: ['Keawe'], transcriptionEnabled: false })
  })

  it('reports effective and override separately for a scene', async () => {
    const { app } = await build()
    await app.inject({ method: 'PUT', url: `/v1/worlds/${GUILD}/defaults`, payload: { transcriptionEnabled: false } })
    await app.inject({ method: 'PUT', url: `/v1/worlds/${GUILD}/scenes/${CHANNEL}`, payload: { keywords: ['x'] } })

    const res = await app.inject({ method: 'GET', url: `/v1/worlds/${GUILD}/scenes/${CHANNEL}` })
    // The UI needs both: rendering `effective` into the inputs would make every
    // inherited field look explicitly set, and saving would freeze inheritance.
    expect(res.json()).toEqual({
      effective: { keywords: ['x'], transcriptionEnabled: false },
      override: { keywords: ['x'] },
    })
  })

  it('DELETE restores inheritance', async () => {
    const { app } = await build()
    await app.inject({ method: 'PUT', url: `/v1/worlds/${GUILD}/defaults`, payload: { keywords: ['world'] } })
    await app.inject({ method: 'PUT', url: `/v1/worlds/${GUILD}/scenes/${CHANNEL}`, payload: { keywords: ['scene'] } })

    const del = await app.inject({ method: 'DELETE', url: `/v1/worlds/${GUILD}/scenes/${CHANNEL}` })
    expect(del.statusCode).toBe(204)

    const res = await app.inject({ method: 'GET', url: `/v1/worlds/${GUILD}/scenes/${CHANNEL}` })
    expect(res.json()).toEqual({ effective: { keywords: ['world'] }, override: {} })
  })

  it('rejects non-snowflake ids', async () => {
    const { app } = await build()
    expect((await app.inject({ method: 'GET', url: '/v1/worlds/not-a-guild' })).statusCode).toBe(400)
    expect(
      (await app.inject({ method: 'PUT', url: '/v1/worlds/nope/defaults', payload: {} })).statusCode,
    ).toBe(400)
    expect(
      (await app.inject({ method: 'GET', url: `/v1/worlds/${GUILD}/scenes/nope` })).statusCode,
    ).toBe(400)
  })

  it('stores grants and drops malformed ones', async () => {
    const { app } = await build()
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/worlds/${GUILD}/grants`,
      payload: {
        grants: [
          { scope: 'party', id: 'p1', members: [{ discordUserId: '400000000000000005', seat: 'gm' }] },
          { scope: 'not-a-scope', id: 'x' },
        ],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().grants).toHaveLength(1)
    expect(res.json().grants[0].id).toBe('p1')
  })

  it('DELETE on an unconfigured guild does not conjure a world', async () => {
    const { app } = await build()
    const del = await app.inject({ method: 'DELETE', url: `/v1/worlds/${GUILD}/scenes/${CHANNEL}` })
    expect(del.statusCode).toBe(204)

    // Removing from a resource must not create it — this used to flip the
    // world's GET from 404 to 200 by virtue of a delete.
    expect((await app.inject({ method: 'GET', url: `/v1/worlds/${GUILD}` })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/v1/worlds' })).json()).toEqual({ worlds: {} })
  })

  it('clearing the last setting removes the world rather than leaving a shell', async () => {
    const { app } = await build()
    await app.inject({ method: 'PUT', url: `/v1/worlds/${GUILD}/scenes/${CHANNEL}`, payload: { keywords: ['x'] } })
    expect((await app.inject({ method: 'GET', url: `/v1/worlds/${GUILD}` })).statusCode).toBe(200)

    await app.inject({ method: 'DELETE', url: `/v1/worlds/${GUILD}/scenes/${CHANNEL}` })
    expect((await app.inject({ method: 'GET', url: `/v1/worlds/${GUILD}` })).statusCode).toBe(404)
  })

  it('rejects a grants body that is not an array', async () => {
    const { app } = await build()
    const res = await app.inject({ method: 'PUT', url: `/v1/worlds/${GUILD}/grants`, payload: { grants: 'nope' } })
    expect(res.statusCode).toBe(400)
  })
})

describe('export / import', () => {
  it('exports as a download', async () => {
    const { app } = await build()
    await app.inject({ method: 'PUT', url: `/v1/worlds/${GUILD}/defaults`, payload: { keywords: ['Keawe'] } })

    const res = await app.inject({ method: 'GET', url: '/v1/settings/export' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toContain('attachment')
    expect(res.json().worlds[GUILD].defaults.keywords).toEqual(['Keawe'])
  })

  it('round-trips export → import', async () => {
    const first = await build()
    await first.app.inject({ method: 'PUT', url: `/v1/worlds/${GUILD}/defaults`, payload: { keywords: ['Keawe'] } })
    const exported = (await first.app.inject({ method: 'GET', url: '/v1/settings/export' })).json()

    // Wipe, then restore from the downloaded document — the portability claim.
    await rm(path, { force: true })
    const second = await build()
    expect((await second.app.inject({ method: 'GET', url: '/v1/worlds' })).json()).toEqual({ worlds: {} })

    const imported = await second.app.inject({ method: 'PUT', url: '/v1/settings/import', payload: exported })
    expect(imported.statusCode).toBe(200)
    expect((await second.app.inject({ method: 'GET', url: `/v1/worlds/${GUILD}` })).json().defaults.keywords).toEqual([
      'Keawe',
    ])
  })

  it('imports what a partially hand-edited file got right, dropping the rest', async () => {
    const { app } = await build()
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/settings/import',
      payload: {
        version: 1,
        worlds: {
          'not-a-snowflake': { defaults: { keywords: ['dropped'] }, scenes: {} },
          [GUILD]: { defaults: { keywords: ['kept'], discordToken: 'PLANTED' }, scenes: {} },
        },
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().worlds).toBe(1)
    expect(await readFile(path, 'utf-8')).not.toContain('PLANTED')
    expect(await readFile(path, 'utf-8')).not.toContain('dropped')
  })

  it('rejects a non-object document', async () => {
    const { app } = await build()
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/settings/import',
      payload: '"just a string"',
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('single-writer gate — CFG-hosted is READ-ONLY', () => {
  const writes: Array<{ method: 'PUT' | 'DELETE'; url: string }> = [
    { method: 'PUT', url: `/v1/worlds/${GUILD}/defaults` },
    { method: 'PUT', url: `/v1/worlds/${GUILD}/scenes/${CHANNEL}` },
    { method: 'DELETE', url: `/v1/worlds/${GUILD}/scenes/${CHANNEL}` },
    { method: 'PUT', url: `/v1/worlds/${GUILD}/grants` },
    { method: 'PUT', url: '/v1/settings/import' },
  ]

  it.each(writes)('refuses $method $url with 405', async ({ method, url }) => {
    const { app } = await build(true)
    const res = await app.inject({ method, url, payload: { keywords: ['x'], grants: [] } })
    expect(res.statusCode).toBe(405)
    expect(res.json().error).toBe('read_only')
    // RFC 9110: a 405 must say what IS allowed.
    expect(res.headers.allow).toBe('GET')
  })

  it('EVERY registered write route is gated — the list above cannot go stale', async () => {
    // The `writes` list is hand-written, which is the snapshot pattern the
    // credential canary argues against. So instead of trusting it, ask Fastify
    // what write routes actually exist and drive them all: an ungated write
    // added later fails here rather than shipping.
    const { app, routes } = await build(true)
    const writeRoutes = routes.filter((r) => r.method !== 'GET' && r.method !== 'HEAD' && r.method !== 'OPTIONS')
    expect(writeRoutes.length).toBeGreaterThanOrEqual(writes.length)

    for (const route of writeRoutes) {
      const url = route.url.replace(':guildId', GUILD).replace(':channelId', CHANNEL)
      const res = await app.inject({ method: route.method as 'PUT', url, payload: { grants: [] } })
      expect({ route: `${route.method} ${route.url}`, status: res.statusCode }).toEqual({
        route: `${route.method} ${route.url}`,
        status: 405,
      })
    }
  })

  it('leaves the file untouched after a refused write', async () => {
    // Seed with a writable instance, then reopen read-only.
    const seed = await build()
    await seed.app.inject({ method: 'PUT', url: `/v1/worlds/${GUILD}/defaults`, payload: { keywords: ['original'] } })
    const before = await readFile(path, 'utf-8')

    const { app } = await build(true)
    await app.inject({ method: 'PUT', url: `/v1/worlds/${GUILD}/defaults`, payload: { keywords: ['hijacked'] } })

    // Two writers would need reconciling, and a whole-document replace means
    // the loser of a race loses everything, not one field.
    expect(await readFile(path, 'utf-8')).toBe(before)
  })

  it('still serves reads', async () => {
    const seed = await build()
    await seed.app.inject({ method: 'PUT', url: `/v1/worlds/${GUILD}/defaults`, payload: { keywords: ['visible'] } })

    const { app } = await build(true)
    expect((await app.inject({ method: 'GET', url: `/v1/worlds/${GUILD}` })).json().defaults.keywords).toEqual([
      'visible',
    ])
    expect((await app.inject({ method: 'GET', url: '/v1/settings/export' })).statusCode).toBe(200)
  })
})

describe('⚠️ credential guard — nothing plantable is readable back', () => {
  it('never persists or echoes a planted credential key', async () => {
    const { app } = await build()
    await app.inject({
      method: 'PUT',
      url: `/v1/worlds/${GUILD}/scenes/${CHANNEL}`,
      payload: {
        keywords: ['legit'],
        discordToken: 'PLANT-BOT',
        deepgramKey: 'PLANT-DEEPGRAM',
        controlToken: 'PLANT-CONTROL',
        coreServerToken: 'PLANT-CORE',
      },
    })

    const onDisk = await readFile(path, 'utf-8')
    const exported = (await app.inject({ method: 'GET', url: '/v1/settings/export' })).body
    const world = (await app.inject({ method: 'GET', url: `/v1/worlds/${GUILD}` })).body

    for (const sentinel of ['PLANT-BOT', 'PLANT-DEEPGRAM', 'PLANT-CONTROL', 'PLANT-CORE']) {
      expect(onDisk).not.toContain(sentinel)
      expect(exported).not.toContain(sentinel)
      expect(world).not.toContain(sentinel)
    }
  })

  it('rejects a __proto__ body at the parser, before the handler runs', async () => {
    const { app } = await build()
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/worlds/${GUILD}/scenes/${CHANNEL}`,
      payload: '{"__proto__":{"polluted":"yes"},"keywords":["ok"]}',
      headers: { 'content-type': 'application/json' },
    })

    // Fastify's body parser is secure-json-parse with protoAction:'error', so
    // this never reaches the route. Pinned because it is the FIRST layer, and
    // knowing which layer catches what matters when one of them changes: the
    // allow-list in settings-store.ts is the second, covering the paths that
    // don't go through this parser (direct store calls, and an import body
    // already parsed by the time it is normalized).
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('FST_ERR_CTP_INVALID_JSON_BODY')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    // Nothing reached the handler, so nothing was written.
    await expect(readFile(path, 'utf-8')).rejects.toThrow()
  })
})
