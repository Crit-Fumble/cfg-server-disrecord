/**
 * Deepgram tuning harness — replay a real session against a settings matrix (#12).
 *
 * Owner request 2026-07-22: a way to fine-tune Deepgram settings against real
 * audio locally, instead of discovering the effect of a change during a live
 * game. Prompted by #10 (accuracy regression) and the `utteranceEndMs
 * 1500 -> 3000` change in `460980e`, which was reasoned from code rather than
 * measured.
 *
 * Two things make this measure the right knob:
 *
 *   1. **It replays speaking boundaries, not just audio.** The dominant
 *      segment-length control in production is OUR forced `Finalize` on
 *      speaker-end, not Deepgram's `endpointing` — Discord sends frames only
 *      while someone talks, so there is no trailing silence on the socket for
 *      Deepgram to endpoint on. A harness that just streams a file would
 *      exercise only the knob that matters least. The boundaries come from
 *      the file itself: silence padding puts each speaker's byte offset on
 *      the shared wall clock, so non-silent regions ARE the speaking
 *      intervals (see `pcm-speech-regions.ts`).
 *
 *   2. **It drives the real `RecordingSession`.** Not a reimplementation —
 *      the same class, the same `createDeepgramStream`, the same
 *      forced-finalize timer and turn-taking logic production runs. Results
 *      transfer without a translation step. The only concession is the
 *      `tuning` override the session now accepts.
 *
 * Audio is fed at approximately real time. Endpointing is silence-sensitive,
 * so blasting the file through compresses the gaps and changes the behaviour
 * under test; that bounds the matrix, since a 10-minute sample costs about 10
 * minutes per combination. Use `--limit-sec` to shorten the SAMPLE rather
 * than speeding up playback — that keeps every gap the right length.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 *   1. Record one consented session with `DISRECORD_KEEP_PCM=1` to build a
 *      corpus. Per-speaker PCM lands in `$OUTPUT_DIR/pcm/<recordingId>/`.
 *   2. Correct that session's VTT by hand once — it becomes reusable ground
 *      truth for every future sweep.
 *   3. DISRECORD_TUNING=1 npm run tune:deepgram -- \
 *        --pcm-dir /data/recordings/pcm/<recordingId> \
 *        --reference ./corrected.vtt
 *
 * ⚠️ Runs bill real Deepgram usage. Use a SEPARATE dev key — mixing them
 * pollutes production usage figures. The harness refuses to run without an
 * explicit `DISRECORD_TUNING=1`, so it can never fire in CI or unattended.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { logger as rootLogger } from '../../src/logger.js'
import { RecordingSession, type DeepgramStreamTuning } from '../../src/recording/recording-session.js'
import {
  bytesToSec,
  detectSpeechRegions,
  secToBytes,
  PCM_FRAME_MS,
  type SpeechRegion,
} from '../../src/recording/pcm-speech-regions.js'
import { PCM_BYTES_PER_MS } from '../../src/recording/pcm-silence-pad.js'
import { extractVttText, normalizeWords, wordErrorRate } from './wer.js'

const logger = rootLogger.child({ module: 'deepgram-tuning' })

/**
 * Default sweep. Spans the settings this project has actually shipped:
 * 1500/1000 is the pre-#10 tuning that starved the model of context,
 * 3000/2000 is current, 4000/2000 is the original cfg-core-server #359 value.
 * Override with `--matrix '[{"utteranceEndMs":2500,"endpointing":1800}]'`.
 */
const DEFAULT_MATRIX: Array<Pick<DeepgramStreamTuning, 'utteranceEndMs' | 'endpointing'>> = [
  { utteranceEndMs: 1500, endpointing: 1000 },
  { utteranceEndMs: 2000, endpointing: 1500 },
  { utteranceEndMs: 3000, endpointing: 2000 },
  { utteranceEndMs: 4000, endpointing: 2000 },
]

export interface Speaker {
  userId: string
  pcm: Buffer
  regions: SpeechRegion[]
}

/**
 * What the replay drives. `RecordingSession` satisfies it structurally; the
 * indirection exists so the clock loop can be exercised without a Deepgram
 * socket — it is the piece most likely to be subtly wrong (region boundaries,
 * a missed speaker-end), and an untested one would silently invalidate every
 * measurement built on top of it.
 */
export interface SpeakerEventSink {
  onSpeakerStart(userId: string): void
  onSpeakerData(userId: string, frame: Buffer): void
  onSpeakerEnd(userId: string): void
}

interface FinalRecord {
  speakerId: string
  transcript: string
  startSec: number
}

interface CombinationResult {
  tuning: Pick<DeepgramStreamTuning, 'utteranceEndMs' | 'endpointing'>
  finalCount: number
  medianLatencyMs: number | null
  medianWordsPerSegment: number
  wer: number | null
  transcript: string
}

interface Args {
  pcmDir: string
  reference?: string
  limitSec?: number
  matrix: Array<Pick<DeepgramStreamTuning, 'utteranceEndMs' | 'endpointing'>>
  model: string
  language: string
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const pcmDir = get('--pcm-dir')
  if (!pcmDir) {
    throw new Error('--pcm-dir is required (a directory of per-speaker .pcm files)')
  }
  const limitRaw = get('--limit-sec')
  const matrixRaw = get('--matrix')
  return {
    pcmDir,
    reference: get('--reference'),
    limitSec: limitRaw ? Number(limitRaw) : undefined,
    matrix: matrixRaw ? JSON.parse(matrixRaw) : DEFAULT_MATRIX,
    model: get('--model') ?? process.env.DEEPGRAM_MODEL ?? 'nova-3',
    language: get('--language') ?? process.env.DEEPGRAM_LANGUAGE ?? 'en',
  }
}

/**
 * Load a corpus directory into per-speaker buffers.
 *
 * `PcmCapture` rotates each speaker across numbered chunk files
 * (`<userId>-000.pcm`, `<userId>-001.pcm`, ...) which are one continuous
 * stream once concatenated in index order.
 */
async function loadSpeakers(dir: string, limitSec?: number): Promise<Speaker[]> {
  const chunks = new Map<string, Array<{ index: number; path: string }>>()
  for (const name of await readdir(dir)) {
    const match = /^(.+)-(\d+)\.pcm$/.exec(name)
    if (!match) continue
    const [, userId, index] = match
    const list = chunks.get(userId) ?? []
    list.push({ index: Number(index), path: join(dir, name) })
    chunks.set(userId, list)
  }

  const speakers: Speaker[] = []
  for (const [userId, list] of chunks) {
    list.sort((a, b) => a.index - b.index)
    let pcm = Buffer.concat(await Promise.all(list.map((c) => readFile(c.path))))
    if (limitSec != null) pcm = pcm.subarray(0, secToBytes(limitSec))
    speakers.push({ userId, pcm, regions: detectSpeechRegions(pcm) })
  }
  return speakers
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * Feed the corpus through `sink`, reproducing each speaker's speaking turns.
 *
 * A single clock loop advances every speaker together rather than one timer
 * per speaker. That is not just simpler: the session's turn-taking rule
 * (another speaker taking the floor fires the previous speaker's pending
 * finalize immediately) depends on the RELATIVE order of speaker events, so
 * they must share one timeline exactly as they do in a live call.
 *
 * `realtime: false` is a TEST seam only. Real runs must pace to the wall
 * clock — endpointing is silence-sensitive, and compressing the gaps changes
 * the very behaviour under test.
 */
export async function replaySpeakers(
  speakers: Speaker[],
  sink: SpeakerEventSink,
  opts: { realtime?: boolean } = {},
): Promise<void> {
  const realtime = opts.realtime ?? true
  const frameBytes = PCM_FRAME_MS * PCM_BYTES_PER_MS
  const totalBytes = Math.max(...speakers.map((s) => s.pcm.length))
  const speaking = new Set<string>()
  const regionCursor = new Map<string, number>()

  const startedAt = Date.now()
  for (let offset = 0; offset < totalBytes; offset += frameBytes) {
    if (realtime) {
      // Pace to the wall clock this offset represents. Sleeping per-frame
      // drifts; sleeping until an absolute deadline does not.
      const dueIn = startedAt + bytesToSec(offset) * 1000 - Date.now()
      if (dueIn > 1) await sleep(dueIn)
    }

    for (const speaker of speakers) {
      let cursor = regionCursor.get(speaker.userId) ?? 0
      // Retire regions this offset has passed, ending any open turn.
      while (cursor < speaker.regions.length && offset >= speaker.regions[cursor].endByte) {
        if (speaking.has(speaker.userId)) {
          speaking.delete(speaker.userId)
          sink.onSpeakerEnd(speaker.userId)
        }
        cursor++
      }
      regionCursor.set(speaker.userId, cursor)

      const region = speaker.regions[cursor]
      if (!region || offset < region.startByte) continue

      if (!speaking.has(speaker.userId)) {
        speaking.add(speaker.userId)
        sink.onSpeakerStart(speaker.userId)
      }
      const frame = speaker.pcm.subarray(offset, Math.min(offset + frameBytes, region.endByte))
      if (frame.length > 0) sink.onSpeakerData(speaker.userId, frame)
    }
  }

  // Anyone still talking when the sample ran out — the recording ended
  // mid-utterance, which is what session.stop()'s drain exists for.
  for (const userId of speaking) sink.onSpeakerEnd(userId)
}

/** Replay the whole corpus once under one settings combination. */
async function runCombination(
  speakers: Speaker[],
  tuning: Pick<DeepgramStreamTuning, 'utteranceEndMs' | 'endpointing'>,
  args: Args,
  credential: { value: string; scheme: 'Token' },
): Promise<CombinationResult> {
  const finals: FinalRecord[] = []
  const latenciesMs: number[] = []
  const pendingSpeechEndAt = new Map<string, number>()

  const session = new RecordingSession({
    deepgramTokenProvider: () => credential,
    deepgramModel: args.model,
    language: args.language,
    resolveSpeakerName: async (userId) => userId,
    tuning,
    onTranscriptFinal: (event) => {
      finals.push({
        speakerId: event.speakerId,
        transcript: event.transcript,
        startSec: event.startSec,
      })
      // Time from the speaker going quiet to their transcript landing. Only
      // the FIRST final after a speech-end is scored — that is the latency a
      // reader actually waits through.
      const endedAt = pendingSpeechEndAt.get(event.speakerId)
      if (endedAt != null) {
        latenciesMs.push(Date.now() - endedAt)
        pendingSpeechEndAt.delete(event.speakerId)
      }
    },
    logger,
  })

  await replaySpeakers(speakers, {
    // Fire-and-forget exactly as voice-capture does — awaiting the websocket
    // handshake here would stall the shared clock.
    onSpeakerStart: (userId) => void session.onSpeakerStart(userId),
    onSpeakerData: (userId, frame) => session.onSpeakerData(userId, frame),
    onSpeakerEnd: (userId) => {
      pendingSpeechEndAt.set(userId, Date.now())
      void session.onSpeakerEnd(userId)
    },
  })
  await session.stop()

  const ordered = [...finals].sort((a, b) => a.startSec - b.startSec)
  const transcript = ordered.map((f) => f.transcript).join(' ')
  const wordsPerSegment = ordered.map((f) => normalizeWords(f.transcript).length)

  return {
    tuning,
    finalCount: ordered.length,
    medianLatencyMs: median(latenciesMs),
    medianWordsPerSegment: median(wordsPerSegment) ?? 0,
    wer: null,
    transcript,
  }
}

function report(results: CombinationResult[], hasReference: boolean): void {
  const rows = results.map((r) => ({
    settings: `${r.tuning.utteranceEndMs}/${r.tuning.endpointing}`,
    wer: r.wer == null ? '—' : `${(r.wer * 100).toFixed(1)}%`,
    segments: String(r.finalCount),
    latency: r.medianLatencyMs == null ? '—' : `${Math.round(r.medianLatencyMs)}ms`,
    words: r.medianWordsPerSegment.toFixed(1),
  }))

  const header = {
    settings: 'uttEnd/endpt',
    wer: 'WER',
    segments: 'segments',
    latency: 'p50 latency',
    words: 'words/seg',
  }
  const columns = Object.keys(header) as Array<keyof typeof header>
  const width = Object.fromEntries(
    columns.map((c) => [c, Math.max(header[c].length, ...rows.map((r) => r[c].length))]),
  ) as Record<keyof typeof header, number>

  const line = (row: Record<keyof typeof header, string>) =>
    columns.map((c) => row[c].padEnd(width[c])).join('  ')

  process.stdout.write('\n' + line(header) + '\n')
  process.stdout.write(columns.map((c) => '-'.repeat(width[c])).join('  ') + '\n')
  for (const row of rows) process.stdout.write(line(row) + '\n')
  if (!hasReference) {
    process.stdout.write('\nNo --reference supplied, so WER is unscored. Everything else stands.\n')
  }
  process.stdout.write('\n')
}

async function main(): Promise<void> {
  if (process.env.DISRECORD_TUNING !== '1') {
    throw new Error(
      'refusing to run without DISRECORD_TUNING=1 — this harness streams real audio to Deepgram and bills real usage',
    )
  }
  const key = process.env.DEEPGRAM_API_KEY
  if (!key) throw new Error('DEEPGRAM_API_KEY is required (use a SEPARATE dev key, not the production one)')

  const args = parseArgs(process.argv.slice(2))
  const speakers = await loadSpeakers(args.pcmDir, args.limitSec)
  if (speakers.length === 0) {
    throw new Error(`no per-speaker .pcm files found in ${args.pcmDir} — was the session recorded with DISRECORD_KEEP_PCM=1?`)
  }

  const sampleSec = bytesToSec(Math.max(...speakers.map((s) => s.pcm.length)))
  const totalRegions = speakers.reduce((n, s) => n + s.regions.length, 0)
  logger.info(
    {
      speakers: speakers.length,
      sampleSec: +sampleSec.toFixed(1),
      speakingTurns: totalRegions,
      combinations: args.matrix.length,
      estimatedMinutes: +((sampleSec * args.matrix.length) / 60).toFixed(1),
    },
    'replaying corpus at real time — one pass per combination',
  )

  let reference: string | null = null
  if (args.reference) {
    reference = extractVttText(await readFile(args.reference, 'utf-8'))
  }

  const results: CombinationResult[] = []
  for (const tuning of args.matrix) {
    logger.info({ tuning }, 'combination start')
    const result = await runCombination(speakers, tuning, args, { value: key, scheme: 'Token' })
    if (reference) result.wer = wordErrorRate(reference, result.transcript).wer
    results.push(result)
    logger.info(
      { tuning, segments: result.finalCount, wer: result.wer, latencyMs: result.medianLatencyMs },
      'combination done',
    )
  }

  report(results, reference != null)
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : err }, 'tuning harness failed')
  process.exitCode = 1
})
