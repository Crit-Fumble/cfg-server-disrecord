/**
 * Thread-name templates.
 *
 * `threadNameTemplate` was collected by the settings UI for months with NOTHING
 * rendering it — the container named threads itself and never received the
 * value. This is the renderer, so these are the rules it has to keep.
 */

import { renderThreadName } from '../../../src/discord/thread-poster.js'

const VALUES = { voiceChannel: 'Table 1', date: 'Aug 9, 2026', kind: 'Transcription' }

describe('renderThreadName', () => {
  it('substitutes every token', () => {
    expect(renderThreadName('{{voiceChannel}} — {{date}} ({{kind}})', VALUES)).toBe(
      'Table 1 — Aug 9, 2026 (Transcription)',
    )
  })

  it('tolerates whitespace inside the braces', () => {
    expect(renderThreadName('{{ voiceChannel }}/{{  date  }}', VALUES)).toBe('Table 1/Aug 9, 2026')
  })

  it('repeats a token as many times as it appears', () => {
    expect(renderThreadName('{{kind}} {{kind}}', VALUES)).toBe('Transcription Transcription')
  })

  it('LEAVES an unknown token verbatim rather than blanking it', () => {
    // A typo should look like a typo in the thread title. Silently emptying it
    // leaves the operator guessing which of their tokens is wrong.
    expect(renderThreadName('{{voiceChannel}} {{nope}}', VALUES)).toBe('Table 1 {{nope}}')
  })

  it('falls back to the built-in name for an absent or blank template', () => {
    expect(renderThreadName(undefined, VALUES)).toBeNull()
    expect(renderThreadName('', VALUES)).toBeNull()
    expect(renderThreadName('   ', VALUES)).toBeNull()
  })

  it('trims the result', () => {
    expect(renderThreadName('  {{voiceChannel}}  ', VALUES)).toBe('Table 1')
  })

  it('supports a template with no tokens at all', () => {
    expect(renderThreadName('Session Log', VALUES)).toBe('Session Log')
  })
})
