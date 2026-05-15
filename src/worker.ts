/**
 * Worker — per-session recording process.
 *
 * Receives opus audio from core-server via SSE
 * (/api/internal/disrecord/sessions/:id/audio); runs RecordingSession
 * (per-speaker Deepgram); POSTs finalized transcripts + billing ticks back
 * to core-server. Container exits when the session ends.
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

// CT/min comes from `config.ctPerMinute` — core-server's slot-fraction
// formula is the single source of truth. Worker no longer keeps its own
// size→rate table (it would just be a stale shadow that drifts whenever
// the host droplet changes or the markup gets retuned).

export async function startWorker(config: WorkerConfig): Promise<void> {
  logger.info(
    {
      installationId: config.installationId,
      guildId: config.guildId,
      channelId: config.channelId,
      size: config.size,
      deepgramMode: config.deepgramMode,
    },
    'starting cfg-server-disrecord worker',
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
    {
      consentedCount: policy.consentedUserIds.length,
      namedCount: Object.keys(policy.speakerNames).length,
      keywordCount: policy.keywords?.length ?? 0,
      keytermCount: policy.keyterms?.length ?? 0,
    },
    'session policy fetched',
  )

  // ── 2. RecordingSession
  const deepgramKey =
    config.deepgramMode === 'disabled' ? null : config.deepgramKey ?? null
  const consent = new Set(policy.consentedUserIds)
  const session = new RecordingSession({
    deepgramApiKey: deepgramKey,
    consentedUserIds: consent,
    keywords: policy.keywords,
    keyterms: policy.keyterms,
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
    coreServerUrl: config.coreServerUrl,
    token: config.coreServerToken,
    installationId: config.installationId,
    session,
    abortSignal: receiverAborter.signal,
    logger: rootLogger.child({ module: 'voice-receiver' }),
  })

  // ── 4. periodic billing tick (only while NOT paused).
  // The legacy in-process path billed at "first consent" — not at provision.
  // We mirror that by skipping ticks while the session is paused (which
  // core-server toggles via the audio-bus pause/resume events). Without
  // this, users pay for the 0-30s consent-wait window every session.
  const ctPerMin = config.ctPerMinute
  const tickIntervalMs = BILLING_TICK_MINUTES * 60_000
  let lastTickAt = Date.now()
  const tickTimer = setInterval(() => {
    if (session.paused) {
      // Slide lastTickAt forward so the resume-side tick doesn't bill for
      // the paused interval. We bill only for time the worker was active.
      lastTickAt = Date.now()
      return
    }
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
