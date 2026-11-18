/**
 * What an error may not carry into the worker's log. discord.js puts the request on every API error: its URL, which
 * for a webhook call holds the webhook's token (`/webhooks/<id>/<token>`), and its body, which for a caption is what
 * someone said. A log line keeps the request's method, path shape and Discord's answer, never the token or the words.
 */
import pino from 'pino'

const WEBHOOK_TOKEN = /(webhooks\/\d{17,20}\/)[A-Za-z0-9_-]{20,}/g
const DROPPED_FIELDS = ['requestBody'] as const

/** `s` with every Discord webhook token replaced; the webhook id stays readable. */
export function scrubWebhookTokens(s: string): string {
  return s.replace(WEBHOOK_TOKEN, '$1<redacted>')
}

function scrubValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return scrubWebhookTokens(value)
  if (depth > 4 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value)) {
    if ((DROPPED_FIELDS as readonly string[]).includes(key)) continue
    out[key] = scrubValue(v, depth + 1)
  }
  return out
}

/** pino's error serializer, then no request body and no webhook token anywhere in what it kept. */
export function scrubbedErrSerializer(err: unknown): unknown {
  return scrubValue(pino.stdSerializers.err(err as Error), 0)
}
