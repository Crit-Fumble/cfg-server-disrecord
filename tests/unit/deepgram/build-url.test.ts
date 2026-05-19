/**
 * Unit tests for `buildDeepgramUrl` — the pure function that assembles the
 * Deepgram Live WebSocket URL from a caller's options.
 *
 * Locks in the invariants that caused real 400s during v0.9.0 testing:
 *   - `interim_results` is auto-forced to `true` whenever `utterance_end_ms`
 *     is set (Deepgram rejects the combo otherwise)
 *   - Defaults match Discord voice audio (linear16, 48 kHz, 1 channel)
 *   - Keywords with boost weights serialize as multiple `keywords=` params
 */

import { buildDeepgramUrl } from '@/deepgram/client'

function params(url: string): URLSearchParams {
  return new URL(url).searchParams
}

describe('buildDeepgramUrl — defaults', () => {
  it('uses the Deepgram Live WebSocket base URL', () => {
    const url = buildDeepgramUrl()
    expect(url.startsWith('wss://api.deepgram.com/v1/listen?')).toBe(true)
  })

  it('defaults model to nova-3', () => {
    expect(params(buildDeepgramUrl()).get('model')).toBe('nova-3')
  })

  it('defaults language to en', () => {
    expect(params(buildDeepgramUrl()).get('language')).toBe('en')
  })

  it('defaults encoding to linear16 for Discord Opus-decoded frames', () => {
    expect(params(buildDeepgramUrl()).get('encoding')).toBe('linear16')
  })

  it('defaults sample_rate to 48000 (Discord native)', () => {
    expect(params(buildDeepgramUrl()).get('sample_rate')).toBe('48000')
  })

  it('defaults channels to 1 (per-speaker mono streams)', () => {
    expect(params(buildDeepgramUrl()).get('channels')).toBe('1')
  })

  it('defaults punctuate to true', () => {
    expect(params(buildDeepgramUrl()).get('punctuate')).toBe('true')
  })

  it('defaults interim_results to false when utterance_end_ms is NOT set', () => {
    expect(params(buildDeepgramUrl()).get('interim_results')).toBe('false')
  })
})

describe('buildDeepgramUrl — the interim_results auto-force rule (Deepgram 400 fix)', () => {
  it('auto-forces interim_results=true whenever utterance_end_ms is set', () => {
    // This is the bug we hit: setting utteranceEndMs=2500 with the default
    // interimResults=false made Deepgram reject the handshake with HTTP 400
    // for every reconnect (~50/sec in a retry loop). The client must force
    // interim_results=true automatically.
    const url = buildDeepgramUrl({ utteranceEndMs: 2500 })
    const q = params(url)
    expect(q.get('interim_results')).toBe('true')
    expect(q.get('utterance_end_ms')).toBe('2500')
  })

  it('respects an explicit interimResults=true even without utteranceEndMs', () => {
    const url = buildDeepgramUrl({ interimResults: true })
    expect(params(url).get('interim_results')).toBe('true')
  })

  it('an explicit interimResults=false is OVERRIDDEN when utteranceEndMs is set', () => {
    // Callers cannot accidentally disable interim results while asking for
    // end-of-utterance events. The override keeps the WebSocket healthy.
    const url = buildDeepgramUrl({ utteranceEndMs: 1500, interimResults: false })
    expect(params(url).get('interim_results')).toBe('true')
  })

  it('does NOT set utterance_end_ms when the caller omits it', () => {
    const url = buildDeepgramUrl({})
    expect(params(url).has('utterance_end_ms')).toBe(false)
  })
})

describe('buildDeepgramUrl — endpointing + smart_format', () => {
  it('serializes smart_format=true when enabled', () => {
    const url = buildDeepgramUrl({ smartFormat: true })
    expect(params(url).get('smart_format')).toBe('true')
  })

  it('omits smart_format when false / undefined', () => {
    expect(params(buildDeepgramUrl({})).has('smart_format')).toBe(false)
    expect(params(buildDeepgramUrl({ smartFormat: false })).has('smart_format')).toBe(false)
  })

  it('serializes endpointing as a number when a positive value is passed', () => {
    expect(params(buildDeepgramUrl({ endpointing: 1000 })).get('endpointing')).toBe('1000')
  })

  it('serializes endpointing=false as the literal string "false"', () => {
    // Deepgram distinguishes "not set" (use their default) from "false"
    // (disable endpointing entirely). We must pass the literal string.
    expect(params(buildDeepgramUrl({ endpointing: false })).get('endpointing')).toBe('false')
  })

  it('omits endpointing when the caller omits it', () => {
    expect(params(buildDeepgramUrl({})).has('endpointing')).toBe(false)
  })
})

describe('buildDeepgramUrl — keywords (Nova-3 fold-into-keyterm)', () => {
  // Nova-3 doesn't accept the `keywords` parameter at all (Deepgram
  // returns HTTP 400 on the WebSocket handshake). Since the worker
  // defaults to Nova-3, the URL builder folds any caller-provided
  // `keywords` into the `keyterm` list with the `:boost` suffix
  // stripped. The legacy keyword-param shape is preserved only for
  // callers that explicitly opt into an older model.
  it('folds keywords into keyterm with the :boost suffix stripped on Nova-3', () => {
    const url = buildDeepgramUrl({ keywords: ['Gandalf:5', 'Fireball:3', 'Longsword:2'] })
    const q = params(url)
    expect(q.has('keywords')).toBe(false)
    expect(q.getAll('keyterm')).toEqual(['Gandalf', 'Fireball', 'Longsword'])
  })

  it('still emits `keywords` when the caller explicitly targets a non-Nova-3 model', () => {
    const url = buildDeepgramUrl({ model: 'nova-2', keywords: ['Gandalf:5'] })
    const q = params(url)
    expect(q.getAll('keywords')).toEqual(['Gandalf:5'])
    expect(q.has('keyterm')).toBe(false)
  })

  it('omits keywords AND keyterm entirely when both lists are empty', () => {
    expect(params(buildDeepgramUrl({})).has('keywords')).toBe(false)
    expect(params(buildDeepgramUrl({})).has('keyterm')).toBe(false)
    expect(params(buildDeepgramUrl({ keywords: [] })).has('keyterm')).toBe(false)
  })

  it('strips :boost for multi-word keywords folded into keyterm', () => {
    const url = buildDeepgramUrl({ keywords: ['Ancient Red Dragon:3'] })
    expect(params(url).getAll('keyterm')).toEqual(['Ancient Red Dragon'])
  })
})

describe('buildDeepgramUrl — keyterms (Nova-3 phrase boost, #677)', () => {
  // Deepgram's documented param name is `keyterm` SINGULAR (repeated).
  // The plural form `keyterms` returns HTTP 400 on the handshake — see
  // the comment in client.ts and https://developers.deepgram.com/docs/keyterm.
  // The caller's API still takes a `keyterms` array (list-of-keyterms
  // reads naturally); only the wire-level param name is singular.
  it('appends each keyterm as a separate `keyterm=` param', () => {
    const url = buildDeepgramUrl({
      keyterms: ['ancient red dragon', 'kick em in the unmentionables'],
    })
    const all = params(url).getAll('keyterm')
    expect(all).toEqual(['ancient red dragon', 'kick em in the unmentionables'])
  })

  it('does not emit the (invalid) plural `keyterms` param', () => {
    const url = buildDeepgramUrl({ keyterms: ['ancient red dragon'] })
    expect(params(url).has('keyterms')).toBe(false)
  })

  it('omits keyterm entirely when the list is empty or undefined', () => {
    expect(params(buildDeepgramUrl({})).has('keyterm')).toBe(false)
    expect(params(buildDeepgramUrl({ keyterms: [] })).has('keyterm')).toBe(false)
  })

  it('merges keywords (boost-stripped) and keyterms into a single keyterm list on Nova-3', () => {
    const url = buildDeepgramUrl({
      keywords: ['Gandalf:5'],
      keyterms: ['ancient red dragon'],
    })
    const q = params(url)
    expect(q.has('keywords')).toBe(false)
    // Order: keywords-derived first, then explicit keyterms — matches
    // the order the builder collects them, and dedupe is case-insensitive
    // so collisions across the two lists collapse safely.
    expect(q.getAll('keyterm')).toEqual(['Gandalf', 'ancient red dragon'])
  })
})

describe('buildDeepgramUrl — full production call shape', () => {
  it('matches the exact shape TranscriptionCapability passes for a live session', () => {
    const url = buildDeepgramUrl({
      model: 'nova-3',
      language: 'en',
      encoding: 'linear16',
      sampleRate: 48_000,
      channels: 1,
      smartFormat: true,
      utteranceEndMs: 2500,
      endpointing: 1000,
      keywords: ['Dax:5', 'Mumbley:5'],
    })
    const q = params(url)
    expect(q.get('model')).toBe('nova-3')
    expect(q.get('language')).toBe('en')
    expect(q.get('encoding')).toBe('linear16')
    expect(q.get('sample_rate')).toBe('48000')
    expect(q.get('channels')).toBe('1')
    expect(q.get('smart_format')).toBe('true')
    expect(q.get('utterance_end_ms')).toBe('2500')
    expect(q.get('endpointing')).toBe('1000')
    expect(q.get('interim_results')).toBe('true') // auto-forced
    // Nova-3 folds keywords into keyterm with :boost stripped.
    expect(q.has('keywords')).toBe(false)
    expect(q.getAll('keyterm')).toEqual(['Dax', 'Mumbley'])
  })
})
