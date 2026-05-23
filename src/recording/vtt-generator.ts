/**
 * VTT Caption Generator — converts caption entries into WebVTT with speaker
 * labels.
 *
 * Ported verbatim from cfg-core-server's `services/recording/vtt-generator.ts`.
 * Non-consenting speakers show as [redacted] in captions.
 */

import type { CaptionEntry } from './caption-types.js'

/**
 * Generate a WebVTT string from caption entries.
 *
 * @param captions - Sorted caption entries.
 * @param redactedSpeakerIds - Discord user IDs that did not consent.
 * @param opts.offsetSec - Subtracted from every timestamp before emission so
 *                         the file is 0-based relative to the matching MP3 part.
 * @param opts.lengthSec - When set, captions whose `startSec` is at or beyond
 *                         `offsetSec + lengthSec` are dropped.
 */
export function generateVtt(
  captions: CaptionEntry[],
  redactedSpeakerIds: Set<string> = new Set(),
  opts: { offsetSec?: number; lengthSec?: number } = {},
): string {
  const offsetSec = opts.offsetSec ?? 0
  const lengthSec = opts.lengthSec
  const windowEnd = typeof lengthSec === 'number' ? offsetSec + lengthSec : Number.POSITIVE_INFINITY

  // Sort by start time before emission. The caller's array is in ARRIVAL
  // order — Deepgram finals can land out of chronological order when one
  // speaker's stream lags behind another's, or when a mid-session
  // [redacted] placeholder is emitted synchronously while a different
  // speaker's earlier final is still in flight. WebVTT cues are
  // chronological by spec; sorting here makes that an invariant of the
  // generator regardless of input order. Array.sort is stable since
  // ES2019, so ties (same startSec) keep arrival order.
  const sorted = [...captions].sort((a, b) => a.startSec - b.startSec)

  const lines: string[] = ['WEBVTT', '']
  let cueIndex = 0

  for (const entry of sorted) {
    if (entry.startSec < offsetSec) continue
    if (entry.startSec >= windowEnd) continue

    const isRedacted = redactedSpeakerIds.has(entry.speakerId)
    const localStart = Math.max(0, entry.startSec - offsetSec)
    const localEnd = Math.min(windowEnd - offsetSec, entry.endSec - offsetSec)
    if (localEnd <= localStart) continue

    cueIndex++
    const startTs = formatVttTime(localStart)
    const endTs = formatVttTime(localEnd)
    const speaker = isRedacted ? '[redacted]' : entry.speakerName
    const text = isRedacted ? '[redacted]' : entry.transcript

    lines.push(`${cueIndex}`)
    lines.push(`${startTs} --> ${endTs}`)
    lines.push(`<v ${speaker}>${text}`)
    lines.push('')
  }

  return lines.join('\n')
}

/** Format seconds as HH:MM:SS.mmm for VTT. */
function formatVttTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const hStr = String(h).padStart(2, '0')
  const mStr = String(m).padStart(2, '0')
  const sStr = s.toFixed(3).padStart(6, '0')
  return `${hStr}:${mStr}:${sStr}`
}
