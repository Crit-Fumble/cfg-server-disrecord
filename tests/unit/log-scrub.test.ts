/**
 * The worker's log never holds a Discord webhook token or a caption's words (log-scrub.ts). discord.js puts the
 * request's URL and body on every API error; a webhook URL carries the webhook's token and a caption's body is
 * what someone said.
 */
import pino from 'pino'
import { scrubbedErrSerializer, scrubWebhookTokens } from '../../src/log-scrub.js'
import { logger } from '../../src/logger.js'

// Built at runtime so the source never holds a credential-shaped URL for gitleaks to flag.
const TOKEN = ['uYyzOY', 'x7T65MLDtn', 'ab'.repeat(26)].join('-')
const URL = `https://discord.com/api/v10/webhooks/1572439147057127506/${TOKEN}/messages/1572439143810605067?thread_id=157`

function discordApiError(): Error {
  return Object.assign(new Error('Unknown Message'), {
    name: 'DiscordAPIError[10008]',
    code: 10008,
    status: 404,
    method: 'PATCH',
    url: URL,
    requestBody: { files: [], json: { content: 'Alright. We were dealing with the dragon', username: 'Mumbley' } },
    rawError: { message: 'Unknown Message', code: 10008 },
  })
}

describe('scrubbedErrSerializer', () => {
  it('keeps what a reader needs from a Discord error, without the webhook token or the caption', () => {
    const out = scrubbedErrSerializer(discordApiError()) as Record<string, unknown>
    const text = JSON.stringify(out)
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain('dragon')
    expect(out).not.toHaveProperty('requestBody')
    expect(out).toMatchObject({ message: 'Unknown Message', code: 10008, status: 404, method: 'PATCH' })
    expect(out.url).toBe('https://discord.com/api/v10/webhooks/1572439147057127506/<redacted>/messages/1572439143810605067?thread_id=157')
  })

  it('scrubs a token from an error message, its stack and a nested cause', () => {
    const err = new Error(`request to ${URL} failed`, { cause: new Error(`retry of ${URL}`) })
    expect(JSON.stringify(scrubbedErrSerializer(err))).not.toContain(TOKEN)
  })

  it('leaves an ordinary error as pino would write it', () => {
    const err = new Error('disk full')
    expect(JSON.stringify(scrubbedErrSerializer(err))).toBe(JSON.stringify(pino.stdSerializers.err(err)))
  })
})

describe('scrubWebhookTokens', () => {
  it('leaves a webhook path with no token, and other ids, alone', () => {
    const line = 'PATCH /api/v10/webhooks/1572439147057127506/messages/1572439143810605067'
    expect(scrubWebhookTokens(line)).toBe(line)
  })
})

describe('the worker logger', () => {
  it('serializes every logged err through the scrub', () => {
    const serializers = (logger as unknown as Record<symbol, Record<string, unknown>>)[pino.symbols.serializersSym]
    expect(serializers.err).toBe(scrubbedErrSerializer)
  })
})
