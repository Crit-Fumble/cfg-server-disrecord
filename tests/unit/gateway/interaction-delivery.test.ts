/**
 * Interaction delivery detection.
 *
 * The failure this guards is the worst shape available: a real user clicks a
 * consent button, Discord says "didn't respond in time", the audio gate stays
 * shut, the session records silence, and NOTHING appears in the container's
 * logs — because from its side nothing happened.
 *
 * Cause: Discord delivers interactions over the gateway OR by HTTP to the
 * application's Interactions Endpoint URL, never both. Setting that URL stops
 * gateway delivery application-wide, and the consent handler listens on the
 * gateway.
 */

import { fetchInteractionDelivery, warnIfButtonsCannotFire } from '../../../src/gateway/interaction-delivery.js'

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as never
}

const realFetch = global.fetch

afterEach(() => {
  global.fetch = realFetch
})

function mockApp(body: unknown, ok = true) {
  global.fetch = jest.fn(async () => ({ ok, json: async () => body })) as never
}

describe('fetchInteractionDelivery', () => {
  it('reports `http` and the URL when an endpoint is configured', async () => {
    mockApp({ interactions_endpoint_url: 'https://example.invalid/hook' })
    expect(await fetchInteractionDelivery('tok', makeLogger())).toEqual({
      route: 'http',
      endpointUrl: 'https://example.invalid/hook',
    })
  })

  it('reports `gateway` when the field is absent', async () => {
    mockApp({ name: 'a bot with no endpoint' })
    expect(await fetchInteractionDelivery('tok', makeLogger())).toEqual({
      route: 'gateway',
      endpointUrl: null,
    })
  })

  it('treats an empty string as no endpoint', async () => {
    // Discord returns "" rather than null for a cleared field.
    mockApp({ interactions_endpoint_url: '' })
    expect((await fetchInteractionDelivery('tok', makeLogger())).route).toBe('gateway')
  })

  it('degrades to `unknown` on a non-OK response', async () => {
    mockApp({}, false)
    expect(await fetchInteractionDelivery('tok', makeLogger())).toEqual({
      route: 'unknown',
      endpointUrl: null,
    })
  })

  it('degrades to `unknown` rather than throwing when Discord is unreachable', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('ENOTFOUND')
    }) as never
    // Not knowing must never stop a recording.
    expect(await fetchInteractionDelivery('tok', makeLogger())).toEqual({
      route: 'unknown',
      endpointUrl: null,
    })
  })
})

describe('warnIfButtonsCannotFire', () => {
  it('warns, naming the endpoint and both escape hatches', () => {
    const logger = makeLogger()
    warnIfButtonsCannotFire({ route: 'http', endpointUrl: 'https://example.invalid/hook' }, logger)

    const warn = (logger as unknown as { warn: jest.Mock }).warn
    expect(warn).toHaveBeenCalledTimes(1)
    const [ctx, msg] = warn.mock.calls[0]
    expect(ctx.interactionsEndpointUrl).toBe('https://example.invalid/hook')
    // The operator needs to know it is fatal for buttons, and what to do.
    expect(msg).toMatch(/NEVER FIRE/)
    expect(msg).toMatch(/SILENCE/)
    expect(msg).toMatch(/dashboard|consent/)
  })

  it('stays quiet on the gateway route', () => {
    const logger = makeLogger()
    warnIfButtonsCannotFire({ route: 'gateway', endpointUrl: null }, logger)
    expect((logger as unknown as { warn: jest.Mock }).warn).not.toHaveBeenCalled()
  })

  it('stays quiet when detection failed — no warning is better than a wrong one', () => {
    const logger = makeLogger()
    warnIfButtonsCannotFire({ route: 'unknown', endpointUrl: null }, logger)
    expect((logger as unknown as { warn: jest.Mock }).warn).not.toHaveBeenCalled()
  })
})
