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
 *   POST /api/v1/disrecord/deepgram-token
 *        Mints a short-lived Deepgram grant token for platform-mode
 *        transcription (the platform key never enters the container).
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
  /**
   * `server_uptime` — recording skill-server container uptime, billed by
   * instance size (the unified server-uptime axis).
   * `transcription` — the optional live-transcription surcharge (platform
   * Deepgram key only).
   */
  resourceType: 'server_uptime' | 'transcription'
  minutes: number
  ctPerMinute: number
  label: string
}

/** A minted Deepgram grant token + its TTL. */
export interface DeepgramTokenResult {
  accessToken: string
  expiresIn: number
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

  /**
   * Fetch a short-lived Deepgram grant token for platform-mode transcription.
   *
   * Returns `null` when self-host (no `cfg`) or when core-server is
   * unreachable / rejects the request. Callers fall back to record-only on a
   * null — the platform key never enters the container, so there is no other
   * credential to use. Throws nothing: a failure is a graceful null.
   */
  async fetchDeepgramToken(): Promise<DeepgramTokenResult | null> {
    if (!this.cfg) return null
    const url = this.url('/api/v1/disrecord/deepgram-token')
    try {
      // Send a valid empty JSON object so Fastify's body parser doesn't reject
      // the request — `this.headers()` always sets content-type: application/json,
      // and the parser refuses an empty body when that content-type is declared.
      // The route reads nothing off the body (it mints from the JWT claims).
      const res = await fetch(url, { method: 'POST', headers: this.headers(), body: '{}' })
      if (!res.ok) {
        this.logger?.warn({ status: res.status }, 'deepgram-token fetch non-2xx')
        return null
      }
      const body = (await res.json()) as Partial<DeepgramTokenResult>
      if (!body.accessToken) {
        this.logger?.warn('deepgram-token response missing accessToken')
        return null
      }
      return { accessToken: body.accessToken, expiresIn: body.expiresIn ?? 3600 }
    } catch (err) {
      this.logger?.warn({ err }, 'deepgram-token fetch threw')
      return null
    }
  }

  /**
   * POST a billing tick. No-op self-host; best-effort hosted.
   *
   * Returns `{ insufficientCoins }` so a caller (the session-controller's
   * `server_uptime` tick) can gracefully stop the recording when the user runs
   * out of Crit-Coin mid-session (#120). The contract is deliberately
   * conservative: ONLY a genuine HTTP 402 sets `insufficientCoins: true`.
   *
   *   - self-host (`cfg == null`)            ⇒ false (never bill, never stop)
   *   - res.ok (2xx)                         ⇒ false
   *   - res.status === 402                   ⇒ true  (the stop signal)
   *   - any OTHER non-2xx                    ⇒ false (warn-log, best-effort no-op)
   *   - thrown / network error               ⇒ false (warn-log, best-effort no-op)
   *
   * CRITICAL: only a true 402 stops a recording. A transient core-server
   * failure (500, 503, ECONNREFUSED, …) must NOT tear down an in-progress
   * recording — billing is best-effort, but recording integrity is not
   * sacrificed to a flaky meter.
   */
  async postBillingTick(payload: BillingTickPayload): Promise<{ insufficientCoins: boolean }> {
    if (!this.cfg) return { insufficientCoins: false }
    const url = this.url('/api/v1/billing/uptime-tick')
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ installationId: this.cfg.installationId, ...payload }),
      })
      if (res.ok) return { insufficientCoins: false }
      // Any 402 means the user is out of Crit-Coin — parse the body
      // defensively (it may be absent/malformed) but treat the STATUS as
      // authoritative. This is the only branch that stops a recording.
      if (res.status === 402) {
        await res.json().catch(() => undefined)
        this.logger?.warn(
          { status: res.status, resourceType: payload.resourceType, minutes: payload.minutes },
          'billing tick POST 402 — insufficient Crit-Coin',
        )
        return { insufficientCoins: true }
      }
      // Every other non-2xx is a transient/unexpected failure: warn, but keep
      // the recording running (best-effort no-op).
      this.logger?.warn(
        { status: res.status, resourceType: payload.resourceType, minutes: payload.minutes },
        'billing tick POST non-2xx',
      )
      return { insufficientCoins: false }
    } catch (err) {
      this.logger?.warn({ err }, 'billing tick POST threw')
      return { insufficientCoins: false }
    }
  }
}
