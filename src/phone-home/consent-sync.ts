/**
 * ConsentSync — CFG-hosted consent bridge.
 *
 * In the CFG-hosted path consent has TWO sources that must converge on the
 * one {@link ConsentManager} a recording owns:
 *
 *   1. In-Discord buttons   — handled directly by ConsentManager (Phase 1).
 *   2. core-server          — the platform already holds RecordingConsent
 *                             rows (set via the web UI / prior sessions).
 *
 * This module wires source #2:
 *
 *   - {@link seedFromPolicy} — on recording start, fetch the session policy
 *     and apply each pre-consented user. Runs once.
 *   - {@link applyPushedUpdate} — core-server pushes mid-session consent
 *     changes to the control API (`POST /v1/recordings/:id/consent`); the
 *     control server routes them here.
 *
 * Both paths funnel through `ConsentManager.applyConsent` / `applyDecline`,
 * which are idempotent — so a user who clicks the Discord button AND has a
 * core-server row converges cleanly with no double-fire.
 *
 * Self-host: ConsentSync is simply never constructed (the session
 * controller only builds it when `cfg` is present), so there is no no-op
 * branch to maintain here.
 */

import type { ConsentManager } from '../consent/consent-manager.js'
import type { CoreServerClient } from './core-client.js'
import type { Logger } from '../logger.js'

export interface ConsentSyncParams {
  consent: ConsentManager
  core: CoreServerClient
  logger: Logger
}

export class ConsentSync {
  private readonly consent: ConsentManager
  private readonly core: CoreServerClient
  private readonly logger: Logger

  constructor(params: ConsentSyncParams) {
    this.consent = params.consent
    this.core = params.core
    this.logger = params.logger
  }

  /**
   * Seed the consent manager from core-server's session policy. Best-effort:
   * a policy fetch failure logs and returns without applying anything, so
   * the recording still starts (every speaker simply stays opt-out until
   * they click the Discord button).
   */
  async seedFromPolicy(): Promise<void> {
    const policy = await this.core.fetchSessionPolicy()
    let applied = 0
    for (const userId of policy.consentedUserIds) {
      this.consent.applyConsent(userId)
      applied++
    }
    this.logger.info({ applied }, 'consent-sync: seeded consent from session policy')
  }

  /**
   * Apply a consent update pushed by core-server. Idempotent — delegates to
   * the manager's idempotent apply methods.
   */
  applyPushedUpdate(userId: string, consented: boolean): void {
    if (consented) {
      this.consent.applyConsent(userId)
    } else {
      this.consent.applyDecline(userId)
    }
    this.logger.info({ userId, consented }, 'consent-sync: applied pushed consent update')
  }
}
