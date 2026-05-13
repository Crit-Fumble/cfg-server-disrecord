/**
 * Pino structured logger. Per-module children via .child(name).
 */
import pino from 'pino'

const level = process.env.LOG_LEVEL ?? 'info'
const mode = (process.env.RESESH_MODE_HINT ?? '?').slice(0, 16)

export const logger = pino({
  level,
  base: { mode, pid: process.pid },
})

export type Logger = typeof logger
