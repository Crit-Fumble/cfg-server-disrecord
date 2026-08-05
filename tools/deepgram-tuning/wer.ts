/**
 * Word Error Rate — the accuracy half of the tuning harness (#12).
 *
 * WER is the metric that answers #10 ("is accuracy actually better?"). It is
 * edit distance over WORD sequences rather than characters: the count of
 * substitutions + insertions + deletions needed to turn the hypothesis into
 * the reference, divided by the reference length.
 *
 * The reference is the manual part of the loop — correct one session's VTT by
 * hand once and it becomes reusable ground truth for every future sweep.
 *
 * Pure. No I/O, no clock.
 */

export interface WerResult {
  /** substitutions + insertions + deletions, over reference word count. */
  wer: number
  substitutions: number
  insertions: number
  deletions: number
  referenceWords: number
  hypothesisWords: number
}

/**
 * Reduce a transcript to a comparable word sequence.
 *
 * Punctuation and case are stripped because they are a *formatting* choice
 * (`smart_format`, `punctuate`), not an accuracy one — leaving them in would
 * score a settings change that only moved a comma as an accuracy regression.
 */
export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * Strip WebVTT scaffolding down to spoken text. Accepts a plain-text
 * reference unchanged, so a hand-corrected transcript can be either.
 */
export function extractVttText(content: string): string {
  if (!content.trimStart().startsWith('WEBVTT')) return content
  const spoken: string[] = []
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (line === 'WEBVTT') continue
    if (line.startsWith('NOTE')) continue
    // Cue timing (`00:00:01.000 --> 00:00:04.000`) and bare cue indices.
    if (line.includes('-->')) continue
    if (/^\d+$/.test(line)) continue
    // `<v Speaker>text` — drop the voice span, keep what was said.
    spoken.push(line.replace(/<v\s[^>]*>/g, '').replace(/<\/?[^>]+>/g, ''))
  }
  return spoken.join(' ')
}

/**
 * Levenshtein over word sequences, tracking each edit kind so a regression
 * can be read as "it started inventing words" vs "it started dropping them".
 *
 * Two rolling rows rather than a full matrix — a 12-hour reference is ~100k
 * words and the square matrix would be 10^10 cells.
 */
export function wordErrorRate(reference: string, hypothesis: string): WerResult {
  const ref = normalizeWords(reference)
  const hyp = normalizeWords(hypothesis)

  interface Cell {
    cost: number
    sub: number
    ins: number
    del: number
  }
  const start = (): Cell => ({ cost: 0, sub: 0, ins: 0, del: 0 })

  let prev: Cell[] = [start()]
  for (let j = 1; j <= hyp.length; j++) {
    prev[j] = { cost: j, sub: 0, ins: j, del: 0 }
  }

  for (let i = 1; i <= ref.length; i++) {
    const row: Cell[] = [{ cost: i, sub: 0, ins: 0, del: i }]
    for (let j = 1; j <= hyp.length; j++) {
      if (ref[i - 1] === hyp[j - 1]) {
        row[j] = { ...prev[j - 1] }
        continue
      }
      const sub = prev[j - 1]
      const del = prev[j]
      const ins = row[j - 1]
      // Ties break toward substitution, then deletion — arbitrary but fixed,
      // so the same inputs always yield the same breakdown.
      if (sub.cost <= del.cost && sub.cost <= ins.cost) {
        row[j] = { cost: sub.cost + 1, sub: sub.sub + 1, ins: sub.ins, del: sub.del }
      } else if (del.cost <= ins.cost) {
        row[j] = { cost: del.cost + 1, sub: del.sub, ins: del.ins, del: del.del + 1 }
      } else {
        row[j] = { cost: ins.cost + 1, sub: ins.sub, ins: ins.ins + 1, del: ins.del }
      }
    }
    prev = row
  }

  const final = prev[hyp.length]
  return {
    // An empty reference cannot be scored; report 0 rather than NaN/Infinity
    // so a missing-reference run doesn't poison the comparison table.
    wer: ref.length === 0 ? 0 : final.cost / ref.length,
    substitutions: final.sub,
    insertions: final.ins,
    deletions: final.del,
    referenceWords: ref.length,
    hypothesisWords: hyp.length,
  }
}
