/**
 * Voice-connection recovery — keeps a recording alive across momentary
 * lapses in Discord connectivity.
 *
 * ## Why this exists
 *
 * `@discordjs/voice` only self-heals PART of the way. From its
 * `VoiceConnection.onNetworkingClose`:
 *
 *   - close code **4014** (kicked / moved / channel deleted / session
 *     invalidated) → state becomes `Disconnected` and it stops there,
 *     by design, waiting for the application to decide.
 *   - **any other** close code → it auto-rejoins (Ready → Signalling) by
 *     sending a fresh join payload through the adapter. BUT if
 *     `adapter.sendPayload()` fails — which is precisely what happens when
 *     the MAIN gateway websocket is also down, i.e. an actual Discord API
 *     lapse — it falls through to `Disconnected(AdapterUnavailable)` and
 *     **also stops there**.
 *
 * With no `Disconnected` listener, both paths are terminal and silent. The
 * recording session keeps running, keeps billing active minutes, and keeps
 * writing an empty mix — the worst possible outcome, because nobody finds
 * out until the session is over and the audio is gone.
 *
 * So: a blip must be retried, not mourned. `rejoin()` returning false is a
 * TRANSIENT condition (the shard is mid-reconnect), so we keep trying for a
 * generous window rather than bailing on the first failure.
 *
 * The retry delay is a flat interval on purpose. The payload is a single
 * small gateway message, so there is nothing to be gained by backing off,
 * and fast retries are exactly what makes a two-second blip invisible.
 */

import type { Logger } from '../logger.js'

export interface VoiceReconnectDeps {
  /**
   * Attempt a rejoin. Returns false when the payload could not be sent
   * (adapter unavailable — the main gateway is down). Never terminal.
   */
  rejoin: () => boolean
  /** Resolve once the connection reaches Ready; reject on timeout. */
  awaitReady: (timeoutMs: number) => Promise<void>
  /** True once the connection is destroyed — the session is deliberately over. */
  isDestroyed: () => boolean
  sleep: (ms: number) => Promise<void>
  now: () => number
  logger: Logger
}

export interface VoiceReconnectOptions {
  /** Total time to keep trying before giving up. Default 10 min. */
  windowMs?: number
  /** Delay between attempts. Default 5s. */
  retryDelayMs?: number
  /** How long a single attempt waits for Ready. Default 20s. */
  readyTimeoutMs?: number
}

const DEFAULT_WINDOW_MS = 10 * 60_000
const DEFAULT_RETRY_DELAY_MS = 5_000
const DEFAULT_READY_TIMEOUT_MS = 20_000

/**
 * Drive a disconnected voice connection back to Ready.
 *
 * Resolves `true` once Ready is reached, or `false` if the connection was
 * destroyed (session ended) or the recovery window elapsed. Never throws —
 * callers are recovery paths and must not themselves need a try/catch.
 */
export async function recoverVoiceConnection(
  deps: VoiceReconnectDeps,
  opts: VoiceReconnectOptions,
): Promise<boolean> {
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS

  const deadline = deps.now() + windowMs
  let attempt = 0

  while (deps.now() < deadline) {
    if (deps.isDestroyed()) {
      deps.logger.info('voice connection destroyed during recovery — session is over, standing down')
      return false
    }

    attempt++
    let sent = false
    try {
      sent = deps.rejoin()
    } catch (err) {
      // A throwing adapter is the same class of problem as one that
      // returns false: transient, and worth another go.
      deps.logger.warn({ err, attempt }, 'voice rejoin threw — retrying')
    }

    if (sent) {
      try {
        await deps.awaitReady(readyTimeoutMs)
        deps.logger.info({ attempt }, 'voice connection recovered — audio capture resumed')
        return true
      } catch {
        deps.logger.warn({ attempt }, 'voice rejoin sent but never reached Ready — retrying')
      }
    } else {
      // AdapterUnavailable: the main gateway websocket is down. discord.js
      // reconnects shards on its own, so this clears itself — wait it out.
      deps.logger.warn({ attempt }, 'voice rejoin could not be sent (gateway down) — retrying')
    }

    if (deps.isDestroyed()) return false
    await deps.sleep(retryDelayMs)
  }

  deps.logger.error(
    { attempts: attempt, windowMs },
    'voice connection did NOT recover within the window — audio capture is down, recording left running for manual intervention',
  )
  return false
}
