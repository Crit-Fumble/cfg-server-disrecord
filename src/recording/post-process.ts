/**
 * Recording Post-Processor — mixes per-speaker PCM files into a single MP3,
 * trims leading/trailing silence, generates VTT captions (when transcription
 * is on), and hands the result to a pluggable {@link OutputSink}.
 *
 * Ported from cfg-core-server's `services/recording/post-processor.ts`,
 * stripped of Prisma + the hardcoded object-storage upload — the storage step
 * is now a sink call so the standalone container can store locally (Phase 1)
 * and the CFG-hosted path can upload to object storage (Phase 2).
 */

import { stat, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { generateVtt } from './vtt-generator.js'
import { buildFfmpegArgs, runFfmpeg, probeDuration } from './ffmpeg.js'
import { findPausesFromSilenceDetect } from './audio-splitter.js'
import type { RecordingResult } from './pcm-capture.js'
import type { CaptionEntry } from './caption-types.js'
import type { OutputSink, RecordingMeta } from './output-sink.js'
import type { Logger } from '../logger.js'

/** Silence longer than this at the start/end of the mix is trimmed to a 1s buffer. */
const SILENCE_TRIM_BUFFER_SEC = 1

export interface PostProcessOptions {
  captions?: CaptionEntry[]
  redactedSpeakerIds?: Set<string>
}

export interface PostProcessResult {
  /** Absolute path of the finalized mp3 in the temp dir. */
  mp3Path: string
  /** Absolute path of the generated VTT, when transcription produced captions. */
  vttPath?: string
  sizeBytes: number
  durationMs: number
  captions: CaptionEntry[]
  /** Durable location returned by the sink. */
  mp3Location: string
  vttLocation?: string
}

/**
 * Process a completed recording: mix → trim → VTT → sink.
 *
 * Returns null when there is nothing to mix (zero speakers).
 */
export async function processRecording(
  recordingId: string,
  result: RecordingResult,
  sink: OutputSink,
  meta: RecordingMeta,
  logger: Logger,
  options: PostProcessOptions = {},
): Promise<PostProcessResult | null> {
  const { tempDir, speakerFiles, speakerCount } = result

  if (speakerCount === 0) {
    logger.warn({ recordingId }, 'post-process: no speakers recorded')
    return null
  }

  const outputPath = join(tempDir, 'mixed.mp3')

  // 1. Mix per-speaker PCM into MP3.
  const args = buildFfmpegArgs(speakerFiles, outputPath)
  logger.info({ recordingId, ffmpegArgs: args }, 'post-process: ffmpeg mix args')
  await runFfmpeg(args, recordingId)

  let fileStat = await stat(outputPath)
  let duration = await probeDuration(outputPath)
  logger.info(
    { recordingId, mixedSizeBytes: fileStat.size, mixedDurationSec: duration },
    'post-process: mixed MP3 stats (pre-trim)',
  )

  // 1b. Trim leading/trailing silence.
  let trimStartSec = 0
  let trimmedCaptions = options.captions ?? []
  try {
    const pauses = await findPausesFromSilenceDetect(outputPath, recordingId)
    let trimEndSec = duration

    const head = pauses[0]
    if (head && head.startSec < 0.1 && head.durationSec > SILENCE_TRIM_BUFFER_SEC) {
      trimStartSec = Math.max(0, head.endSec - SILENCE_TRIM_BUFFER_SEC)
    }

    const tail = pauses[pauses.length - 1]
    if (tail && tail.endSec > duration - 0.1 && tail.durationSec > SILENCE_TRIM_BUFFER_SEC) {
      trimEndSec = Math.min(duration, tail.startSec + SILENCE_TRIM_BUFFER_SEC)
    }

    if (trimStartSec > 0 || trimEndSec < duration) {
      const trimmedPath = join(tempDir, 'mixed-trimmed.mp3')
      await runFfmpeg(
        [
          '-hide_banner', '-loglevel', 'error', '-nostdin',
          '-ss', String(trimStartSec),
          '-to', String(trimEndSec),
          '-i', outputPath,
          '-c', 'copy', '-y', trimmedPath,
        ],
        recordingId,
      )
      await rename(trimmedPath, outputPath)
      fileStat = await stat(outputPath)
      duration = await probeDuration(outputPath)

      trimmedCaptions = []
      for (const c of options.captions ?? []) {
        const newStart = c.startSec - trimStartSec
        const newEnd = c.endSec - trimStartSec
        if (newEnd <= 0) continue
        if (newStart >= duration) continue
        trimmedCaptions.push({
          ...c,
          startSec: Math.max(0, newStart),
          endSec: Math.min(duration, newEnd),
        })
      }
      logger.info(
        { recordingId, trimStartSec, durationSec: duration, captionsRetained: trimmedCaptions.length },
        'post-process: trimmed recording',
      )
    }
  } catch (err) {
    logger.warn({ err, recordingId }, 'post-process: silence-trim pass failed — using un-trimmed file')
  }

  // 2. Generate VTT when transcription produced captions.
  let vttPath: string | undefined
  if (trimmedCaptions.length > 0) {
    const vttContent = generateVtt(trimmedCaptions, options.redactedSpeakerIds)
    vttPath = join(tempDir, 'captions.vtt')
    await writeFile(vttPath, vttContent, 'utf-8')
  }

  // 3. Hand off to the sink.
  const stored = await sink.putRecording(recordingId, outputPath, vttPath, meta)

  logger.info(
    { recordingId, sizeBytes: fileStat.size, durationSec: duration, mp3Location: stored.mp3Location },
    'post-process: recording finalized',
  )

  return {
    mp3Path: outputPath,
    vttPath,
    sizeBytes: fileStat.size,
    durationMs: Math.round(duration * 1000),
    captions: trimmedCaptions,
    mp3Location: stored.mp3Location,
    vttLocation: stored.vttLocation,
  }
}
