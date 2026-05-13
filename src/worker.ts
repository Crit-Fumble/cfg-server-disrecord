/**
 * Worker — per-session recording process (Option B).
 *
 * Receives opus audio from gateway via SSE; runs RecordingSession (per-speaker
 * Deepgram); POSTs finalized transcripts + billing ticks to core-server.
 *
 * Lifecycle:
 *   1. fetch session policy from core-server (consent set, speaker names)
 *   2. wire RecordingSession with policy + transcript callback
 *   3. wire VoiceReceiver as SSE consumer
 *   4. start the periodic billing tick
 *   5. wait for SSE session-end OR SIGTERM
 *   6. final billing tick + close session
 */

import { logger as rootLogger } from './logger.js'
import type { WorkerConfig } from './config.js'
import { RecordingSession, type TranscriptFinalEvent } from './worker/recording-session.js'
import { VoiceReceiver } from './worker/voice-receiver.js'
import { CoreServerClient } from './worker/core-server-client.js'

const logger = rootLogger.child({ module: 'worker' })

/** Periodic CT billing tick (uptime). 15 min matches existing cfg-core-server cadence. */
const BILLING_TICK_MINUTES = 15

/**
 * Local CT/min rates per size. Mirrors cfg-core-server's
 * localContainerRates.vttSizes shape (we reuse those numbers because the
 * resource shape is identical). When pricing config moves into shared, swap
 * for a runtime lookup.
 */
const CT_PER_MIN_BY_SIZE: Record<WorkerConfig['size'], number> = {
  nano: 6,
  micro: 8,
  small: 16,
}

export async function startWorker(config: WorkerConfig): Promise<void> {
  logger.info(
    {
      installationId: config.installationId,
      guildId: config.guildId,
      channelId: config.channelId,
      size: config.size,
      deepgramMode: config.deepgramMode,
    },
    'starting cfg-resesh worker',
  )

  // ── 1. core-server client + session policy
  const core = new CoreServerClient({
    baseUrl: config.coreServerUrl,
    token: config.coreServerToken,
    installationId: config.installationId,
    logger: rootLogger.child({ module: 'core-server-client' }),
  })
  const policy = await core.fetchSessionPolicy()
  logger.info(
    { consentedCount: policy.consentedUserIds.length, namedCount: Object.keys(policy.speakerNames).length },
    'session policy fetched',
  )

  // ── 2. RecordingSession
  const deepgramKey =
    config.deepgramMode === 'disabled' ? null : config.deepgramKey ?? null
  const consent = new Set(policy.consentedUserIds)
  const session = new RecordingSession({
    deepgramApiKey: deepgramKey,
    consentedUserIds: consent,
    resolveSpeakerName: async (userId) => policy.speakerNames[userId] ?? userId,
    onTranscriptFinal: async (event: TranscriptFinalEvent) => {
      await core.postTranscript({
        speakerId: event.speakerId,
        speakerName: event.speakerName,
        transcript: event.transcript,
        isRedacted: event.isRedacted,
        startSec: event.startSec,
        endSec: event.endSec,
        words: event.words.length > 0 ? event.words : undefined,
      })
    },
    logger: rootLogger.child({ module: 'recording-session' }),
  })

  // ── 3. VoiceReceiver (SSE consumer)
  const receiverAborter = new AbortController()
  const receiver = new VoiceReceiver({
    gatewayUrl: config.gatewayUrl,
    sessionToken: config.sessionToken,
    installationId: config.installationId,
    session,
    abortSignal: receiverAborter.signal,
    logger: rootLogger.child({ module: 'voice-receiver' }),
  })

  // ── 4. periodic billing tick
  const ctPerMin = CT_PER_MIN_BY_SIZE[config.size]
  const tickIntervalMs = BILLING_TICK_MINUTES * 60_000
  let lastTickAt = Date.now()
  const tickTimer = setInterval(() => {
    const now = Date.now()
    const minutes = (now - lastTickAt) / 60_000
    lastTickAt = now
    void core.postBillingTick({
      resourceType: 'bot_container',
      minutes,
      ctPerMinute: ctPerMin,
      label: `Recording Server (${config.size}): ${minutes.toFixed(1)} min`,
    })
  }, tickIntervalMs)
  tickTimer.unref()

  // ── 5. run receiver until shutdown signal
  let stopReason = 'unknown'
  const stopPromise = new Promise<void>((resolve) => {
    const onSignal = (signal: string) => {
      stopReason = signal
      logger.info({ signal }, 'shutdown signal received')
      receiverAborter.abort()
      resolve()
    }
    process.on('SIGTERM', () => onSignal('SIGTERM'))
    process.on('SIGINT', () => onSignal('SIGINT'))
  })

  try {
    await Promise.race([
      receiver.run().catch((err) => {
        logger.error({ err }, 'voice receiver run failed')
        stopReason = 'receiver-error'
      }),
      stopPromise,
    ])
  } finally {
    clearInterval(tickTimer)
  }

  // ── 6. teardown + final tick
  logger.info({ stopReason }, 'worker stopping')
  await receiver.destroy()
  await session.stop()
  const finalMinutes = (Date.now() - lastTickAt) / 60_000
  if (finalMinutes > 0) {
    await core.postBillingTick({
      resourceType: 'bot_container',
      minutes: finalMinutes,
      ctPerMinute: ctPerMin,
      label: `Recording Server (${config.size}): final ${finalMinutes.toFixed(1)} min`,
    })
  }
  logger.info('worker stopped cleanly')
}
