/**
 * Boot failures should teach, not just fail.
 *
 * "Used disallowed intents" is Discord's message when an application lacks the
 * PRIVILEGED gateway intents — which are OFF by default on every newly created
 * app. Raw, it names neither the intents nor where to enable them, so a
 * first-time self-hoster gets a stack trace and no next step. This container
 * cannot run without them.
 */

import { startGateway } from '../../../src/gateway/discord-gateway.js'

const shardHandlers: Array<(err: Error) => void> = []

jest.mock('discord.js', () => ({
  GatewayIntentBits: {
    Guilds: 1,
    GuildVoiceStates: 2,
    GuildMembers: 4,
    GuildMessages: 8,
    MessageContent: 16,
  },
  Client: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    once: jest.fn((event: string, fn: (err: Error) => void) => {
      if (event === 'shardError') shardHandlers.push(fn)
    }),
    // Never resolves — the shardError path is what must reject.
    login: jest.fn(() => new Promise(() => undefined)),
    user: null,
  })),
}))

const silentLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as never

beforeEach(() => {
  shardHandlers.length = 0
})

describe('startGateway — boot failure messages', () => {
  it('turns "Used disallowed intents" into an actionable instruction', async () => {
    const booting = startGateway('tok', silentLogger)
    // Discord reports this on the SHARD, not from login() — so a naive
    // implementation stalls for the full ready timeout and reports nothing useful.
    shardHandlers.forEach((fn) => fn(new Error('Used disallowed intents')))

    await expect(booting).rejects.toThrow(/SERVER MEMBERS INTENT/)
    await expect(booting).rejects.toThrow(/MESSAGE CONTENT INTENT/)
    await expect(booting).rejects.toThrow(/Developer Portal/)
  })

  it('passes an unrelated shard error through unchanged', async () => {
    const booting = startGateway('tok', silentLogger)
    shardHandlers.forEach((fn) => fn(new Error('ECONNRESET')))

    // Only the one failure worth translating gets translated; inventing
    // explanations for everything else would be worse than silence.
    await expect(booting).rejects.toThrow(/^ECONNRESET$/)
  })
})
