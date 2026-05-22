/**
 * FFmpeg utilities — spawn wrapper, arg builder, and ffprobe duration probe.
 *
 * Ported verbatim from cfg-core-server's `services/recording/ffmpeg.ts`,
 * with the logger swapped for this repo's pino instance. Used by
 * post-process.ts (mix + trim) and audio-splitter.ts (silence detect + split).
 */

import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { logger as rootLogger } from '../logger.js'

const logger = rootLogger.child({ module: 'ffmpeg' })
const execFileAsync = promisify(execFile)

export const ffmpegPath = 'ffmpeg'

export const SAMPLE_RATE = 48_000
export const CHANNELS = 1

/** Hard ceiling on how long ffmpeg is allowed to run before we kill it. */
export const FFMPEG_TIMEOUT_MS = 15 * 60 * 1000

/** Tail of stderr kept for error diagnostics. Everything past this is discarded. */
const FFMPEG_STDERR_TAIL_BYTES = 16 * 1024

/**
 * Build ffmpeg args to mix N speakers (each with one or more raw PCM chunk
 * files) into a single MP3. Each speaker's chunks are concatenated in order
 * via ffmpeg's `concat:` protocol. Output is MP3 VBR quality 5 (~130 kbps).
 *
 * The chunk list MUST be in chronological (lexicographic) order — PcmCapture
 * writes `<userId>-NNN.pcm` with zero-padded indices for exactly this reason.
 */
export function buildFfmpegArgs(speakerFiles: Map<string, string[]>, outputPath: string): string[] {
  const inputs = Array.from(speakerFiles.values())
    .map((chunks) => {
      if (chunks.length === 0) return null
      if (chunks.length === 1) return chunks[0]
      return `concat:${chunks.join('|')}`
    })
    .filter((s): s is string => s !== null)
  const args: string[] = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '2']

  for (const file of inputs) {
    args.push('-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', String(CHANNELS), '-i', file)
  }

  if (inputs.length === 1) {
    args.push('-codec:a', 'libmp3lame', '-q:a', '5', '-y', outputPath)
  } else {
    args.push(
      '-filter_complex',
      `amix=inputs=${inputs.length}:duration=longest:normalize=0`,
      '-codec:a',
      'libmp3lame',
      '-q:a',
      '5',
      '-y',
      outputPath,
    )
  }

  return args
}

/**
 * Spawn ffmpeg, stream stderr into a small tail buffer, and wait for exit.
 */
export async function runFfmpeg(args: string[], recordingId: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] })

    let stderrTail = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail += chunk.toString('utf8')
      if (stderrTail.length > FFMPEG_STDERR_TAIL_BYTES) {
        stderrTail = stderrTail.slice(-FFMPEG_STDERR_TAIL_BYTES)
      }
    })

    const killTimer = setTimeout(() => {
      logger.error({ recordingId, timeoutMs: FFMPEG_TIMEOUT_MS }, 'ffmpeg timeout — killing')
      child.kill('SIGKILL')
    }, FFMPEG_TIMEOUT_MS)

    child.once('error', (err) => {
      clearTimeout(killTimer)
      reject(err)
    })

    child.once('close', (code, signal) => {
      clearTimeout(killTimer)
      if (code === 0) {
        resolve()
        return
      }
      const tail = stderrTail.trim().slice(-2048)
      reject(new Error(`ffmpeg exited with code=${code} signal=${signal ?? 'none'}: ${tail}`))
    })
  })
}

/** Probe MP3 duration using ffprobe. */
export async function probeDuration(filePath: string): Promise<number> {
  try {
    const ffprobePath = 'ffprobe'
    const { stdout } = await execFileAsync(ffprobePath, [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'csv=p=0',
      filePath,
    ])
    return parseFloat(stdout.trim()) || 0
  } catch {
    return 0
  }
}
