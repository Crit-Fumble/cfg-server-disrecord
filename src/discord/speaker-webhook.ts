/**
 * Speaker Webhook Manager — one Discord webhook per speaker per recording.
 *
 * Each consenting speaker gets their own webhook in the recording's parent
 * text channel. The webhook's `username` + `avatarURL` are the speaker's
 * Discord display name + avatar, so live captions appear in chat under
 * the speaker's identity — Discord's chat renderer then auto-groups
 * consecutive messages from the same webhook under a single header (the
 * "paragraph under one speaker" UX).
 *
 * ### Webhook naming + feature namespaces
 *
 * Every ReSesh-owned webhook starts with the shared prefix `cfg-resesh-`
 * so we (and ops) can identify the full set of ReSesh-managed webhooks
 * in a channel at a glance. Within that prefix each feature carves out
 * its own namespace via a 3-letter tag:
 *
 *   - `cfg-resesh-rec-<recordingId>-<userId>` — per-speaker recording captions
 *   - `cfg-resesh-cic-…`                      — reserved for future Chat in Character
 *
 * Sweep + audit operate on the recording (`rec`) namespace specifically;
 * other ReSesh features own their own sweep, so this manager leaves
 * non-`rec` ReSesh webhooks alone.
 *
 * ### Hygiene
 *
 * Discord caps a channel at 15 webhooks shared across all bots/integrations.
 * Stale webhooks from crashed prior sessions (or other bots) eat into that
 * cap. Two cleanup paths:
 *
 *   1. **On-start sweep** — `init()` deletes any `cfg-resesh-rec-*` webhook
 *      in the parent channel whose recordingId isn't ours. Per-guild only
 *      one recording is active at a time (one bot voice connection per
 *      guild), so any other `rec-` webhook is necessarily orphaned.
 *   2. **On-stop cleanup** — `cleanup()` deletes every webhook this
 *      manager created during the session.
 *
 * `audit()` returns a categorized list of all `cfg-resesh-*` webhooks in
 * the parent channel — useful for the control-API `GET /v1/webhooks`
 * endpoint, where an admin can see what's there before sweeping.
 *
 * Threading: webhooks are channel-scoped, but Discord supports sending
 * to a thread under the parent channel via `threadId`. Callers pass the
 * recording thread's id on send/edit.
 *
 * Permission: the bot needs MANAGE_WEBHOOKS in the parent channel. When
 * the permission is missing or the channel hits the 15-webhook cap (any
 * combination of bots/integrations), `getOrCreate` returns null and the
 * caller should fall back to posting via the bot's own user.
 */

import type { Client, TextChannel, Webhook } from 'discord.js'
import type { Logger } from '../logger.js'

/** Discord per-channel webhook cap (shared across all integrations). */
const MAX_WEBHOOKS_PER_CHANNEL = 15

/** Prefix every ReSesh-owned webhook starts with. */
export const RESESH_WEBHOOK_PREFIX = 'cfg-resesh-'
/** Recording (this manager's) feature tag. */
export const RECORDING_FEATURE_TAG = 'rec'

/**
 * Marker name for a recording webhook. Discord caps webhook names at 80
 * chars; recordingId is short and speakerId is a Discord snowflake
 * (~19 digits), so this fits comfortably.
 */
function webhookName(recordingId: string, speakerId: string): string {
  return `${RESESH_WEBHOOK_PREFIX}${RECORDING_FEATURE_TAG}-${recordingId}-${speakerId}`.slice(0, 80)
}

/** Is this any ReSesh-owned webhook (recording, future CiC, etc.)? */
export function isReseshWebhookName(name: string): boolean {
  return name.startsWith(RESESH_WEBHOOK_PREFIX)
}

/** Is this a recording webhook (any session)? */
export function isRecordingWebhookName(name: string): boolean {
  return name.startsWith(`${RESESH_WEBHOOK_PREFIX}${RECORDING_FEATURE_TAG}-`)
}

/** Is this a recording webhook for THIS session specifically? */
function isMyRecordingWebhookName(name: string, recordingId: string): boolean {
  return name.startsWith(`${RESESH_WEBHOOK_PREFIX}${RECORDING_FEATURE_TAG}-${recordingId}-`)
}

export interface SpeakerIdentity {
  speakerId: string
  displayName: string
  avatarURL: string | null
}

export interface WebhookAuditEntry {
  id: string
  name: string
  /** Categorization for the audit caller. */
  kind: 'mine' | 'recording-stale' | 'resesh-other-feature' | 'foreign'
}

export interface SweepResult {
  /** Webhooks belonging to this session — left alone. */
  kept: number
  /** Stale recording webhooks (other recordingIds) deleted. */
  deleted: number
  /** Non-recording ReSesh webhooks (e.g. future CiC) — left alone, not ours to sweep. */
  otherReseshFeature: number
  /** Webhooks owned by other bots/integrations — never touched. */
  foreign: number
  /** True when the sweep couldn't run (missing perm, fetch error). */
  unavailable: boolean
}

export class SpeakerWebhookManager {
  private readonly cache = new Map<string, Webhook>()
  private capReached = false
  /**
   * `true` once we've confirmed the bot can manage webhooks here (any
   * successful create/list). `false` once a perm-shaped failure tells us
   * to give up. Used to short-circuit retries when MANAGE_WEBHOOKS is
   * missing — the first failure marks this false and subsequent calls
   * return null immediately.
   */
  private canManage: boolean | null = null

  constructor(
    private readonly client: Client,
    private readonly parentChannelId: string,
    private readonly recordingId: string,
    private readonly logger: Logger,
  ) {}

  /**
   * One-time per-session init. Sweeps stale recording webhooks (any
   * `cfg-resesh-rec-*` from a different recordingId — necessarily
   * orphaned, since only one recording is active per guild at a time),
   * freeing slots back to the 15-webhook cap before new sends start.
   * Best-effort: missing perms or fetch errors are logged and ignored —
   * the manager still functions in fallback mode.
   */
  async init(): Promise<SweepResult> {
    return this.sweepStale('init')
  }

  /**
   * Sweep stale recording webhooks now. Same logic as `init()` but
   * exposed for the control-API endpoint so an admin can free slots
   * mid-session (e.g. after a crash that left orphans).
   */
  async sweepStale(reason: 'init' | 'manual' = 'manual'): Promise<SweepResult> {
    const result: SweepResult = {
      kept: 0,
      deleted: 0,
      otherReseshFeature: 0,
      foreign: 0,
      unavailable: false,
    }
    const existing = await this.fetchExistingWebhooks()
    if (existing == null) {
      result.unavailable = true
      return result
    }
    for (const w of existing) {
      if (!isReseshWebhookName(w.name)) {
        result.foreign++
        continue
      }
      if (isMyRecordingWebhookName(w.name, this.recordingId)) {
        result.kept++
        continue
      }
      if (!isRecordingWebhookName(w.name)) {
        // Some other ReSesh feature owns it (e.g. future CiC). Not ours
        // to sweep — that feature's own manager handles its hygiene.
        result.otherReseshFeature++
        continue
      }
      // Stale recording webhook from a prior session.
      try {
        await w.delete(`ReSesh sweep (${reason}) — stale recording webhook from a prior session`)
        result.deleted++
      } catch (err) {
        this.logger.warn({ err, webhookId: w.id, name: w.name }, 'stale webhook delete failed (best-effort)')
      }
    }
    this.logger.info(
      { recordingId: this.recordingId, reason, ...result },
      'webhook sweep complete',
    )
    return result
  }

  /**
   * Categorized list of every `cfg-resesh-*` + foreign webhook in the
   * parent channel. Returns null when fetch fails (missing perm).
   */
  async audit(): Promise<WebhookAuditEntry[] | null> {
    const existing = await this.fetchExistingWebhooks()
    if (existing == null) return null
    return existing.map((w) => ({
      id: w.id,
      name: w.name,
      kind: isMyRecordingWebhookName(w.name, this.recordingId)
        ? ('mine' as const)
        : isRecordingWebhookName(w.name)
          ? ('recording-stale' as const)
          : isReseshWebhookName(w.name)
            ? ('resesh-other-feature' as const)
            : ('foreign' as const),
    }))
  }

  /**
   * Return the webhook for this speaker, creating it if needed. Returns
   * null when the bot can't manage webhooks here OR the channel hit its
   * webhook cap — caller should fall back to bot messages in that case.
   */
  async getOrCreate(identity: SpeakerIdentity): Promise<Webhook | null> {
    const cached = this.cache.get(identity.speakerId)
    if (cached) return cached
    if (this.canManage === false) return null
    if (this.capReached) return null

    const channel = await this.client.channels.fetch(this.parentChannelId).catch(() => null)
    if (!channel || !this.isWebhookCapableTextChannel(channel)) {
      this.canManage = false
      return null
    }
    const text = channel as TextChannel

    // Look for a webhook we created in a prior op (e.g. earlier in this
    // same session if the cache was reset). Not the same as
    // sweepStale-and-reuse — we only reuse webhooks for THIS session.
    let webhook: Webhook | null = null
    try {
      const existing = await text.fetchWebhooks()
      this.canManage = true
      webhook = existing.find((w) => w.name === webhookName(this.recordingId, identity.speakerId)) ?? null
      if (!webhook && existing.size >= MAX_WEBHOOKS_PER_CHANNEL) {
        this.capReached = true
        this.logger.warn(
          { parentChannelId: this.parentChannelId, count: existing.size },
          'channel at webhook cap — falling back to bot messages for remaining speakers',
        )
        return null
      }
    } catch (err) {
      this.canManage = false
      this.logger.warn(
        { err, parentChannelId: this.parentChannelId },
        'fetchWebhooks failed (missing MANAGE_WEBHOOKS?) — falling back to bot messages',
      )
      return null
    }

    if (!webhook) {
      try {
        webhook = await text.createWebhook({
          name: webhookName(this.recordingId, identity.speakerId),
          avatar: identity.avatarURL ?? undefined,
          reason: `ReSesh recording ${this.recordingId} — per-speaker caption webhook`,
        })
      } catch (err) {
        this.logger.warn(
          { err, speakerId: identity.speakerId, parentChannelId: this.parentChannelId },
          'createWebhook failed — falling back to bot messages for this speaker',
        )
        return null
      }
    }

    this.cache.set(identity.speakerId, webhook)
    return webhook
  }

  /** Delete every webhook this manager created. Best-effort. */
  async cleanup(): Promise<void> {
    const webhooks = Array.from(this.cache.values())
    this.cache.clear()
    await Promise.all(
      webhooks.map((w) =>
        w.delete(`ReSesh recording ${this.recordingId} ended`).catch((err: unknown) =>
          this.logger.warn({ err, webhookId: w.id }, 'webhook delete failed (best-effort)'),
        ),
      ),
    )
  }

  /** Shared fetch path. Returns null on any error (canManage flipped). */
  private async fetchExistingWebhooks(): Promise<Webhook[] | null> {
    if (this.canManage === false) return null
    const channel = await this.client.channels.fetch(this.parentChannelId).catch(() => null)
    if (!channel || !this.isWebhookCapableTextChannel(channel)) {
      this.canManage = false
      return null
    }
    const text = channel as TextChannel
    try {
      const existing = await text.fetchWebhooks()
      this.canManage = true
      return Array.from(existing.values())
    } catch (err) {
      this.canManage = false
      this.logger.warn(
        { err, parentChannelId: this.parentChannelId },
        'fetchWebhooks failed (missing MANAGE_WEBHOOKS?)',
      )
      return null
    }
  }

  private isWebhookCapableTextChannel(channel: { type: number }): boolean {
    // ChannelType.GuildText === 0; webhooks live on parent text channels.
    return channel.type === 0
  }
}
