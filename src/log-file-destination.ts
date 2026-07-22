/**
 * Optional second log destination: a file on the mounted output volume.
 *
 * Worker containers run with `AutoRemove`, so their logs die with the
 * container. That is why a lost wrap-up could not be diagnosed after the fact
 * (cfg-core-server#205) — by the time anyone looked, the only copy was gone.
 * Writing a second copy onto the already-bind-mounted output volume makes the
 * logs outlive the container without touching AutoRemove.
 *
 * Deliberately NOT in the container's temp dir: that is a size-capped tmpfs
 * shared with the ffmpeg mix, and filling it is a live suspect for the very
 * failure this exists to explain.
 *
 * Two hard rules, because this is diagnostic plumbing:
 *   1. It can never break the worker. Any failure degrades to stdout-only.
 *   2. It is bounded. A pathological log storm (a per-frame decode warning at
 *      debug level, or a Discord outage warning on every caption op) must not
 *      be able to fill the user's volume.
 */

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'

/** Where the worker's output volume is mounted. Mirrors src/config.ts's default. */
const DEFAULT_OUTPUT_DIR = '/data/recordings'

/**
 * Underscore-prefixed so it can never collide with a recordingId directory
 * written alongside it by the output sink.
 */
const LOG_DIR_NAME = '_logs'

/** Default ceiling per worker boot. Far above a healthy session (~20 KB). */
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024

export interface LogFileDestination {
  stream: NodeJS.WritableStream
  path: string
}

/** Distinguishes destinations opened within the same millisecond. */
let openCount = 0

/**
 * Wrap a file stream so it stops writing once `maxBytes` is exceeded, rather
 * than growing without bound. Emits one final line explaining the cutoff so a
 * reader is never left wondering why the file stops mid-session.
 */
function capped(stream: WriteStream, maxBytes: number): NodeJS.WritableStream {
  let written = 0
  let stopped = false
  return {
    write(chunk: string | Uint8Array): boolean {
      if (stopped) return true
      written += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
      if (written > maxBytes) {
        stopped = true
        stream.write(
          `{"level":40,"msg":"log file cap reached (${maxBytes} bytes) — file logging disabled, stdout continues"}\n`,
        )
        stream.end()
        return true
      }
      return stream.write(chunk)
    },
    end(): void {
      if (!stopped) stream.end()
    },
  } as unknown as NodeJS.WritableStream
}

/**
 * Open the worker's log file, or return null when file logging is off or
 * unavailable. Never throws: an unwritable volume must still leave a fully
 * working, stdout-logging worker.
 *
 * Reads env directly rather than the resolved config, because the logger is
 * constructed at module load — before config is resolved.
 */
export function openLogFileDestination(): LogFileDestination | null {
  if (process.env.DISRECORD_LOG_TO_FILE === '0') return null

  const outputDir = process.env.OUTPUT_DIR ?? DEFAULT_OUTPUT_DIR
  const dir = join(outputDir, LOG_DIR_NAME)
  // Identify the boot, not just the session: a worker that is restarted or
  // adopted must not overwrite the log that explains why it restarted. The
  // pid + counter suffix keeps two boots inside the same millisecond distinct.
  const bootId = new Date().toISOString().replace(/[:.]/g, '-')
  const installationId = process.env.CFG_INSTALLATION_ID ?? 'standalone'
  const path = join(dir, `worker-${installationId}-${bootId}-${process.pid}-${++openCount}.log`)

  try {
    mkdirSync(dir, { recursive: true })
    const stream = createWriteStream(path, { flags: 'a' })
    // A later EPIPE/ENOSPC must not become an unhandled error event.
    stream.on('error', () => undefined)
    const maxBytes = Number(process.env.DISRECORD_LOG_FILE_MAX_BYTES ?? DEFAULT_MAX_BYTES)
    return {
      stream: Number.isFinite(maxBytes) && maxBytes > 0 ? capped(stream, maxBytes) : stream,
      path,
    }
  } catch {
    return null
  }
}
