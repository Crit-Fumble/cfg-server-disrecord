/**
 * HTTP client for worker → core-server callbacks.
 *
 * Auth: per-session JWT (CORE_SERVER_TOKEN), minted by core-server at
 * provisioning time. scope='disrecord-worker' + installationId claim, signed
 * with AUTH_SECRET. core-server rejects on scope/installation mismatch.
 *
 * Three endpoints (all under /api/v1/):
 *
 *   GET  /api/v1/recording/session-policy/:installationId
 *        Worker calls on session start to seed RecordingSession's consent set.
 *
 *   POST /api/v1/recording/transcripts
 *        Worker POSTs per finalized utterance. core-server persists and
 *        publishes voiceCaptionEvents SSE.
 *
 *   POST /api/v1/billing/uptime-tick
 *        Worker POSTs periodically + on session end. core-server routes to
 *        chargeContainerUptime.
 */

import type { Logger } from '../logger.js'

export interface CoreServerClientParams {
  baseUrl: string
  token: string
  installationId: string
  logger?: Logger
}

export interface SessionPolicy {
  consentedUserIds: string[]
  speakerNames: Record<string, string>
}

export interface TranscriptPayload {
  speakerId: string
  speakerName: string
  transcript: string
  isRedacted: boolean
  startSec: number
  endSec: number
  /** Optional Deepgram word timing. */
  words?: Array<{ word: string; start: number; end: number; confidence: number }>
}

export interface BillingTickPayload {
  resourceType: 'bot_container' | 'transcription'
  minutes: number
  ctPerMinute: number
  label: string
}

export class CoreServerClient {
  constructor(private readonly params: CoreServerClientParams) {}

  private url(path: string): string {
    return `${this.params.baseUrl.replace(/\/$/, '')}${path}`
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.params.token}`,
      'content-type': 'application/json',
    }
  }

  /**
   * Fetch the session policy (consent + speaker names) for this installation.
   * Returns sensible defaults if core-server is unreachable so the session
   * still records (consent-undefined → no redaction; names → fall back to ID).
   */
  async fetchSessionPolicy(): Promise<SessionPolicy> {
    const url = this.url(`/api/v1/recording/session-policy/${encodeURIComponent(this.params.installationId)}`)
    try {
      const res = await fetch(url, { method: 'GET', headers: this.headers() })
      if (!res.ok) {
        this.params.logger?.warn(
          { status: res.status, installationId: this.params.installationId },
          'session-policy fetch failed; using defaults',
        )
        return { consentedUserIds: [], speakerNames: {} }
      }
      return (await res.json()) as SessionPolicy
    } catch (err) {
      this.params.logger?.warn({ err }, 'session-policy fetch threw; using defaults')
      return { consentedUserIds: [], speakerNames: {} }
    }
  }

  /** POST one finalized transcript event. Best-effort — failures are logged but don't crash. */
  async postTranscript(payload: TranscriptPayload): Promise<void> {
    const url = this.url('/api/v1/recording/transcripts')
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ installationId: this.params.installationId, ...payload }),
      })
      if (!res.ok) {
        this.params.logger?.warn(
          { status: res.status, speakerId: payload.speakerId },
          'transcript POST non-2xx',
        )
      }
    } catch (err) {
      this.params.logger?.warn({ err, speakerId: payload.speakerId }, 'transcript POST threw')
    }
  }

  /** POST a billing tick. Best-effort. */
  async postBillingTick(payload: BillingTickPayload): Promise<void> {
    const url = this.url('/api/v1/billing/uptime-tick')
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ installationId: this.params.installationId, ...payload }),
      })
      if (!res.ok) {
        this.params.logger?.warn(
          { status: res.status, resourceType: payload.resourceType, minutes: payload.minutes },
          'billing tick POST non-2xx',
        )
      }
    } catch (err) {
      this.params.logger?.warn({ err }, 'billing tick POST threw')
    }
  }
}
