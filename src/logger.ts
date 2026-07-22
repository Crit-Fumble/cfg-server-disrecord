/**
 * Pino structured logger. Per-module children via .child(name).
 *
 * Writes to stdout always, and additionally to a file on the mounted output
 * volume when one can be opened — worker containers are AutoRemove, so stdout
 * alone does not survive the container (see log-file-destination.ts).
 */
import pino from 'pino'
import { openLogFileDestination } from './log-file-destination.js'

const level = process.env.LOG_LEVEL ?? 'info'
const mode = (process.env.DISRECORD_MODE_HINT ?? '?').slice(0, 16)

const fileDestination = openLogFileDestination()

// Every stream must carry an explicit level: pino's multistream defaults an
// unspecified per-stream level to 'info', which would silently swallow
// LOG_LEVEL=debug — the setting an operator reaches for while diagnosing.
const destination = fileDestination
  ? pino.multistream([
      { level, stream: process.stdout },
      { level, stream: fileDestination.stream },
    ])
  : process.stdout

export const logger = pino({ level, base: { mode, pid: process.pid } }, destination)

if (fileDestination) {
  logger.info({ path: fileDestination.path }, 'worker log file open')
}

export type Logger = typeof logger
