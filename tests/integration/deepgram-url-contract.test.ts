/**
 * Deepgram URL contract tests — lock the WebSocket URL shape against
 * what Deepgram's documentation actually accepts. These are unit-test
 * speed (pure URL construction, no network) but live under
 * tests/integration/ because they assert against an external contract
 * we don't own. When Deepgram changes their API (or we misread the
 * docs), these are the tests that should turn red first.
 *
 * Each assertion is paired with a docs link so the next person fixing a
 * 400 can verify the contract without spelunking the same pages I did.
 *
 * History of real-world 400s these tests guard against:
 *   - Plural `keyterms` (we sent it, Deepgram wants singular `keyterm`).
 *   - `keywords` with `model=nova-3` (Nova-3 dropped keyword support;
 *     `keyterm` replaces it).
 *   - `utterance_end_ms` set without `interim_results=true` (Deepgram
 *     auto-forced wrong direction in earlier client builds).
 *
 * Plus one opt-in reachability test that distinguishes "URL shape is
 * valid but auth failed" (HTTP 401) from "URL shape is wrong" (HTTP
 * 400). Skipped by default so CI doesn't hit Deepgram; runnable
 * locally with `DEEPGRAM_REACHABILITY_TEST=1 npm test`.
 */

import { buildDeepgramUrl } from '@/deepgram/client'
import { WebSocket } from 'ws'
import type { IncomingMessage } from 'http'

function params(url: string): URLSearchParams {
  return new URL(url).searchParams
}

// ── Param-name contracts ──────────────────────────────────────────────────

describe('Deepgram URL contract — parameter names', () => {
  // Source: https://developers.deepgram.com/docs/keyterm
  // "Add a `keyterm` parameter in the query string and set it to your
  // chosen key term." Repeated for multiple terms.
  it('uses `keyterm` (singular) — Deepgram rejects the plural `keyterms`', () => {
    const url = buildDeepgramUrl({ keyterms: ['ancient red dragon'] })
    const q = params(url)
    expect(q.has('keyterm')).toBe(true)
    expect(q.has('keyterms')).toBe(false)
  })

  // Source: https://developers.deepgram.com/docs/keywords
  // "Keywords is only available for use with Nova-2, Nova-1, Enhanced,
  // and Base speech to text models. For Nova-3, use Keyterm Prompting."
  it('folds `keywords` into `keyterm` when model is nova-3 (Nova-3 drops keyword support)', () => {
    const url = buildDeepgramUrl({ keywords: ['Gandalf:5', 'Fireball:3'] })
    const q = params(url)
    expect(q.has('keywords')).toBe(false)
    expect(q.getAll('keyterm')).toEqual(['Gandalf', 'Fireball'])
  })

  it('preserves `keywords` only when caller explicitly targets a non-Nova-3 model', () => {
    const url = buildDeepgramUrl({ model: 'nova-2', keywords: ['Gandalf:5'] })
    const q = params(url)
    expect(q.getAll('keywords')).toEqual(['Gandalf:5'])
    expect(q.has('keyterm')).toBe(false)
  })

  // Standard streaming params — names per Deepgram's reference docs.
  it('uses snake_case parameter names for all streaming options', () => {
    const url = buildDeepgramUrl({
      model: 'nova-3',
      language: 'en',
      encoding: 'linear16',
      sampleRate: 48_000,
      channels: 1,
      punctuate: true,
      smartFormat: true,
      utteranceEndMs: 4_000,
      endpointing: 500,
      vadEvents: true,
    })
    const q = params(url)
    expect(q.has('model')).toBe(true)
    expect(q.has('language')).toBe(true)
    expect(q.has('encoding')).toBe(true)
    expect(q.has('sample_rate')).toBe(true)
    expect(q.has('channels')).toBe(true)
    expect(q.has('punctuate')).toBe(true)
    expect(q.has('smart_format')).toBe(true)
    expect(q.has('utterance_end_ms')).toBe(true)
    expect(q.has('endpointing')).toBe(true)
    expect(q.has('vad_events')).toBe(true)
    expect(q.has('interim_results')).toBe(true)
    // And none of the common-typo variants:
    expect(q.has('sampleRate')).toBe(false)
    expect(q.has('smartFormat')).toBe(false)
    expect(q.has('vadEvents')).toBe(false)
    expect(q.has('utteranceEndMs')).toBe(false)
  })
})

// ── Required-combination contracts ────────────────────────────────────────

describe('Deepgram URL contract — required combinations', () => {
  // Source: https://developers.deepgram.com/docs/utterance-end
  // "When using `utterance_end_ms`, setting `interim_results=true` is
  // also required." We auto-force this; the test pins that behavior.
  it('forces interim_results=true whenever utterance_end_ms is set', () => {
    const q = params(buildDeepgramUrl({ utteranceEndMs: 2_500 }))
    expect(q.get('interim_results')).toBe('true')
    expect(q.get('utterance_end_ms')).toBe('2500')
  })

  it('still forces interim_results=true even if the caller explicitly passed false', () => {
    const q = params(buildDeepgramUrl({ utteranceEndMs: 2_500, interimResults: false }))
    expect(q.get('interim_results')).toBe('true')
  })

  // Source: https://developers.deepgram.com/docs/keyterm
  // "Set `model=nova-3`." Keyterm without Nova-3 is undefined behavior.
  it('emits keyterm only when model is nova-3 (the keyterm-fold path)', () => {
    // Nova-3 — keywords get folded into keyterm.
    expect(params(buildDeepgramUrl({ keywords: ['Foo'] })).has('keyterm')).toBe(true)
    // Non-Nova-3 — keywords stay as keywords; keyterm is NOT emitted.
    const q = params(buildDeepgramUrl({ model: 'nova-2', keywords: ['Foo'] }))
    expect(q.has('keyterm')).toBe(false)
  })
})

// ── Value-format contracts ────────────────────────────────────────────────

describe('Deepgram URL contract — value formats', () => {
  // Source: https://developers.deepgram.com/docs/utterance-end
  // "Valid range: 1,000–5,000 milliseconds."
  it('serializes utterance_end_ms as an integer string within the documented range', () => {
    const q = params(buildDeepgramUrl({ utteranceEndMs: 4_000 }))
    expect(q.get('utterance_end_ms')).toMatch(/^\d+$/)
    const n = Number(q.get('utterance_end_ms'))
    expect(n).toBeGreaterThanOrEqual(1_000)
    expect(n).toBeLessThanOrEqual(5_000)
  })

  // Source: https://developers.deepgram.com/docs/endpointing
  // "Pass an integer (ms) or the literal `false` to disable."
  it('serializes endpointing=false as the literal string "false"', () => {
    expect(params(buildDeepgramUrl({ endpointing: false })).get('endpointing')).toBe('false')
  })

  it('serializes endpointing=<number> as a digit string', () => {
    expect(params(buildDeepgramUrl({ endpointing: 500 })).get('endpointing')).toMatch(/^\d+$/)
  })

  // Source: https://developers.deepgram.com/docs/models-languages-overview
  // Nova-3 accepts both bare (`en`) and locale-specific (`en-US`) codes.
  it('accepts bare `en` as a valid language code on Nova-3', () => {
    const q = params(buildDeepgramUrl({ language: 'en' }))
    expect(q.get('language')).toBe('en')
    expect(q.get('model')).toBe('nova-3')
  })

  // Source: https://developers.deepgram.com/docs/keyterm
  // "Key Terms are limited to 500 tokens per request."
  // We don't enforce this — caller (composeTranscriptionKeywords + the
  // recording-handler) does — but this test documents the limit so the
  // next reader knows to cap upstream rather than at the URL builder.
  it('does not cap the keyterm count at the URL layer (caller responsibility)', () => {
    const manyTerms = Array.from({ length: 600 }, (_, i) => `term${i}`)
    const url = buildDeepgramUrl({ keyterms: manyTerms })
    // We deliberately don't truncate here — fail loudly via Deepgram's
    // own 500-token error rather than silently dropping terms.
    expect(params(url).getAll('keyterm').length).toBe(600)
  })
})

// ── Production-config contract — the URL we actually ship ─────────────────

describe('Deepgram URL contract — production worker config', () => {
  // This is the exact shape the worker sends in
  // src/recording/recording-session.ts. If any of these change, the test
  // turns red AND we need to re-verify against Deepgram's docs.
  const PRODUCTION_OPTIONS = {
    model: 'nova-3' as const,
    language: 'en' as const,
    encoding: 'linear16' as const,
    sampleRate: 48_000,
    channels: 1,
    smartFormat: true,
    utteranceEndMs: 4_000,
    endpointing: 500,
    vadEvents: true,
  }

  it('emits exactly the params Deepgram documents as supported on Nova-3 streaming', () => {
    const url = buildDeepgramUrl(PRODUCTION_OPTIONS)
    const q = params(url)
    // Required + present:
    expect(q.get('model')).toBe('nova-3')
    expect(q.get('language')).toBe('en')
    expect(q.get('encoding')).toBe('linear16')
    expect(q.get('sample_rate')).toBe('48000')
    expect(q.get('channels')).toBe('1')
    expect(q.get('punctuate')).toBe('true')
    expect(q.get('smart_format')).toBe('true')
    expect(q.get('interim_results')).toBe('true')
    expect(q.get('utterance_end_ms')).toBe('4000')
    expect(q.get('endpointing')).toBe('500')
    expect(q.get('vad_events')).toBe('true')
    // Forbidden on Nova-3:
    expect(q.has('keywords')).toBe(false)
    // Optional (only present when caller passes keyterms/keywords):
    expect(q.has('keyterm')).toBe(false)
  })

  it('keeps the production-config URL under a typical reverse-proxy cap with realistic keyterms', () => {
    // Deepgram doesn't document a URL length limit, but reverse proxies
    // cap somewhere between 4–16 KB. Realistic D&D-style keyterms run
    // ~10-15 chars (proper nouns, item names). 500 of those plus the
    // ~250-char base URL stays well under 16 KB.
    const realistic = Array.from({ length: 500 }, (_, i) => `name-${i}`)
    const url = buildDeepgramUrl({ ...PRODUCTION_OPTIONS, keyterms: realistic })
    expect(url.length).toBeLessThan(16 * 1024)
  })
})

// ── Reachability (opt-in network test) ────────────────────────────────────

/**
 * Hit the real Deepgram endpoint with a placeholder auth token to
 * distinguish "URL shape valid" (returns 401 — auth failed but params
 * accepted) from "URL shape invalid" (returns 400 — params rejected
 * before auth is checked).
 *
 * Skipped by default — CI shouldn't make network calls. Enable locally
 * with `DEEPGRAM_REACHABILITY_TEST=1 npx jest deepgram-url-contract`.
 *
 * Uses the `ws` library directly (same as the worker) so we see the
 * exact handshake response Deepgram returns. Manually-crafted `fetch`
 * requests with `Upgrade: websocket` are blocked by undici with
 * "invalid upgrade header" — the only way to get a real handshake
 * status is through a real WebSocket client.
 */
const RUN_REACHABILITY = process.env.DEEPGRAM_REACHABILITY_TEST === '1'
const reachabilityDescribe = RUN_REACHABILITY ? describe : describe.skip

interface HandshakeResult {
  status: number | null
  body: string
  errorMessage: string | null
}

function probeDeepgramHandshake(url: string, authToken: string): Promise<HandshakeResult> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { Authorization: `Token ${authToken}` } })

    let settled = false
    const settle = (result: HandshakeResult) => {
      if (settled) return
      settled = true
      try {
        ws.terminate()
      } catch {
        // Already torn down — fine.
      }
      resolve(result)
    }

    ws.on('open', () => {
      // Shouldn't happen with a placeholder token, but if Deepgram
      // ever accepts one we still want a deterministic result.
      settle({ status: 101, body: '<open>', errorMessage: null })
    })

    ws.on('unexpected-response', (_req, res: IncomingMessage) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        settle({
          status: res.statusCode ?? null,
          body: Buffer.concat(chunks).toString('utf8').slice(0, 2000),
          errorMessage: null,
        })
      })
      res.on('error', (err) => {
        settle({ status: res.statusCode ?? null, body: '', errorMessage: err.message })
      })
    })

    ws.on('error', (err: Error) => {
      // `unexpected-response` fires first when the issue is HTTP-level;
      // `error` fires for network-level failures (DNS, TLS, etc).
      // Only settle here if we haven't already captured a response.
      settle({ status: null, body: '', errorMessage: err.message })
    })
  })
}

reachabilityDescribe('Deepgram URL reachability (opt-in)', () => {
  it('production URL returns 401 (auth fail) — params accepted', async () => {
    const wsUrl = buildDeepgramUrl({
      model: 'nova-3',
      language: 'en',
      encoding: 'linear16',
      sampleRate: 48_000,
      channels: 1,
      smartFormat: true,
      utteranceEndMs: 4_000,
      endpointing: 500,
      vadEvents: true,
    })
    const result = await probeDeepgramHandshake(wsUrl, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
    // Surface body on failure so the diagnostic lands in the test output.
    if (result.status !== 401) {
      // eslint-disable-next-line no-console
      console.error('reachability probe response:', JSON.stringify(result, null, 2))
    }
    // 401 = params parsed fine, auth was the only blocker (good).
    // 400 = params rejected before auth (bad — URL shape problem).
    expect(result.status).toBe(401)
  }, 10_000)

  it('production URL + 15 keyterms (matching real campaign config) also returns 401', async () => {
    const wsUrl = buildDeepgramUrl({
      model: 'nova-3',
      language: 'en',
      encoding: 'linear16',
      sampleRate: 48_000,
      channels: 1,
      smartFormat: true,
      utteranceEndMs: 4_000,
      endpointing: 500,
      vadEvents: true,
      // Mix of keywords (folded into keyterm with :boost stripped)
      // and explicit keyterms — same shape composeTranscriptionKeywords
      // produces for a real D&D campaign.
      keywords: ['Gandalf:5', 'Fireball:3', 'Longsword:2', 'Aragorn:5', 'Mithril:3'],
      keyterms: ['ancient red dragon', 'kick em in the unmentionables'],
    })
    const result = await probeDeepgramHandshake(wsUrl, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
    if (result.status !== 401) {
      // eslint-disable-next-line no-console
      console.error('reachability probe (with keyterms) response:', JSON.stringify(result, null, 2))
    }
    expect(result.status).toBe(401)
  }, 10_000)
})
