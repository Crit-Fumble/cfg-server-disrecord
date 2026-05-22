/**
 * CoreServerClient — phone-home HTTP client for the CFG-hosted `serve` path.
 *
 * Supersedes `worker/core-server-client.ts` (the legacy SSE-worker path).
 * It carries three responsibilities, all CFG-hosted-only:
 *
 *   GET  /api/v1/recording/session-policy/:installationId
 *        Fetched on recording start to seed the consent set + speaker names.
 *
 *   POST /api/v1/recording/transcripts
 *        One POST per finalized utterance; core-server persists + fans out
 *        the live-caption SSE.
 *
 *   POST /api/v1/billing/uptime-tick
 *        Periodic + final CT billing tick.
 *
 * Blank-slate-boot contract: the client is constructed from the optional
 * {@link CfgHostedConfig}. When that config is `undefined` (no
 * `CORE_SERVER_URL`), every method is a clean, synchronous no-op — it never
 * touches the network. Callers can hold a client unconditionally and not
 * branch on hosted-vs-self-host.
 *
 * Auth: per-session JWT (`coreServerToken`) — scope='disrecord-worker' +
 * installationId claim, HS256, signed with core-server's AUTH_SECRET.
 */

import type { CfgHostedConfig } from '../config.js'
import type { Logger } from '../logger.js'

export interface SessionPolicy {
  consentedUserIds: string[]
  speakerNames: Record<string, string>
  /** Deepgram legacy per-utterance keywords. */
  keywords?: string[]
  /** Deepgram nova-3 keyterms. */
  keyterms?: string[]
}

export interface TranscriptPayload {
  speakerId: string
  speakerName: string
  transcript: string
  isRedacted: boolean
  startSec: number
  endSec: number
  words?: Array<{ word: string; start: number; end: number; confidence: number }>
}

export interface BillingTickPayload {
  resourceType: 'bot_container' | 'transcription'
  minutes: number
  ctPerMinute: number
  label: string
}

/** Empty policy used both as the no-op return and the unreachable-core fallback. */
const EMPTY_POLICY: SessionPolicy = { consentedUserIds: [], speakerNames: {} }

export class CoreServerClient {
  /**
   * @param cfg  CFG-hosted config, or `undefined` for self-host. When
   *             `undefined`, every method is a no-op.
   */
  constructor(
    private readonly cfg: CfgHostedConfig | undefined,
    private readonly logger?: Logger,
  ) {}

  /** True when this client will actually phone home. */
  get enabled(): boolean {
    return this.cfg != null
  }

  private url(path: string): string {
    return `${this.cfg!.coreServerUrl.replace(/\/$/, '')}${path}`
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.cfg!.coreServerToken}`,
      'content-type': 'application/json',
    }
  }

  /**
   * Fetch the session policy for this installation. Returns an empty policy
   * (no-op) when self-host, and also when core-server is unreachable — a
   * transient core-server failure must not block a recording from starting.
   */
  async fetchSessionPolicy(): Promise<SessionPolicy> {
    if (!this.cfg) return EMPTY_POLICY
    const url = this.url(`/api/v1/recording/session-policy/${encodeURIComponent(this.cfg.installationId)}`)
    try {
      const res = await fetch(url, { method: 'GET', headers: this.headers() })
      if (!res.ok) {
        this.logger?.warn(
          { status: res.status, installationId: this.cfg.installationId },
          'session-policy fetch failed; using defaults',
        )
        return EMPTY_POLICY
      }
      return (await res.json()) as SessionPolicy
    } catch (err) {
      this.logger?.warn({ err }, 'session-policy fetch threw; using defaults')
      return EMPTY_POLICY
    }
  }

  /** POST one finalized transcript event. No-op self-host; best-effort hosted. */
  async postTranscript(payload: TranscriptPayload): Promise<void> {
    if (!this.cfg) return
    const url = this.url('/api/v1/recording/transcripts')
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ installationId: this.cfg.installationId, ...payload }),
      })
      if (!res.ok) {
        this.logger?.warn({ status: res.status, speakerId: payload.speakerId }, 'transcript POST non-2xx')
      }
    } catch (err) {
      this.logger?.warn({ err, speakerId: payload.speakerId }, 'transcript POST threw')
    }
  }

  /** POST a billing tick. No-op self-host; best-effort hosted. */
  async postBillingTick(payload: BillingTickPayload): Promise<void> {
    if (!this.cfg) return
    const url = this.url('/api/v1/billing/uptime-tick')
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ installationId: this.cfg.installationId, ...payload }),
      })
      if (!res.ok) {
        this.logger?.warn(
          { status: res.status, resourceType: payload.resourceType, minutes: payload.minutes },
          'billing tick POST non-2xx',
        )
      }
    } catch (err) {
      this.logger?.warn({ err }, 'billing tick POST threw')
    }
  }
}
