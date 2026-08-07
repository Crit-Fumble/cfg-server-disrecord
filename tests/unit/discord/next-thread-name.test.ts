import { nextThreadName } from '../../../src/discord/thread-poster.js'

const BASE = 'Event Staging - Aug 7, 2026 - Transcription'

describe('nextThreadName', () => {
  it('uses the bare base when the family is empty', () => {
    expect(nextThreadName(BASE, [])).toBe(BASE)
    expect(nextThreadName(BASE, ['unrelated', 'Party 1 - Aug 7, 2026 - Recording'])).toBe(BASE)
  })

  it('suffixes 2 when the bare base exists', () => {
    expect(nextThreadName(BASE, [BASE])).toBe(`${BASE} 2`)
  })

  it('increments past the highest existing suffix', () => {
    expect(nextThreadName(BASE, [BASE, `${BASE} 2`])).toBe(`${BASE} 3`)
    expect(nextThreadName(BASE, [`${BASE} 7`])).toBe(`${BASE} 8`)
  })

  it('does not refill gaps — deleted threads must not resurrect their number', () => {
    expect(nextThreadName(BASE, [BASE, `${BASE} 3`])).toBe(`${BASE} 4`)
  })

  it('ignores names that merely start with the base', () => {
    expect(nextThreadName(BASE, [`${BASE} extra words`, `${BASE}2`])).toBe(BASE)
  })

  it('escapes regex metacharacters in channel names', () => {
    const spicy = 'D&D (Tuesdays) [main] - Aug 7, 2026 - Recording'
    expect(nextThreadName(spicy, [spicy])).toBe(`${spicy} 2`)
    expect(nextThreadName('a.c - x', ['abc - x'])).toBe('a.c - x')
  })
})
