/**
 * Speaker Webhook Manager — one Discord webhook per speaker per recording.
 *
 * Each consenting speaker gets their own webhook in the recording's parent
 * text channel, identified by a `cfg-resesh-<recordingId>-<userId>` name
 * marker. The webhook's `username` + `avatarURL` are the speaker's Discord
 * display name + avatar, so live captions appear in chat under the
 * speaker's identity — Discord's chat renderer then auto-groups
 * consecutive messages from the same webhook under a single header
 * (the "paragraph under one speaker" UX). When the session ends the
 * manager deletes all webhooks it created, leaving no residue in the
 * channel's webhook list.
 *
 * Threading: webhooks are channel-scoped, but Discord supports sending
 * to a thread under the parent channel via `threadId`. We always pass
 * the recording thread's id on send/edit.
 *
 * Permission: the bot needs MANAGE_WEBHOOKS in the parent channel. When
 * the permission is missing or the channel hits Discord's 15-webhook cap,
 * `getOrCreate` returns null and the caller should fall back to posting
 * via the bot's own user.
 */

import type { Client, TextChannel, Webhook } from 'discord.js'
import type { Logger } from '../logger.js'

/** Discord per-channel webhook cap. */
const MAX_WEBHOOKS_PER_CHANNEL = 15

/** Marker prefix so we can identify + delete the webhooks we created. */
function webhookName(recordingId: string, speakerId: string): string {
  // Discord webhook names cap at 80 chars; recordingId is a short id and
  // speakerId is a snowflake (~19 digits), so the combined name fits.
  return `cfg-resesh-${recordingId}-${speakerId}`.slice(0, 80)
}

export interface SpeakerIdentity {
  speakerId: string
  displayName: string
  avatarURL: string | null
}

export class SpeakerWebhookManager {
  private readonly cache = new Map<string, Webhook>()
  private readonly capReached = new Set<string>()
  /**
   * `true` once we've confirmed the bot can manage webhooks here (any
   * successful create or list). Used to short-circuit retries when the
   * permission is missing — the first failure marks this false and
   * subsequent calls return null immediately.
   */
  private canManage: boolean | null = null

  constructor(
    private readonly client: Client,
    private readonly parentChannelId: string,
    private readonly recordingId: string,
    private readonly logger: Logger,
  ) {}

  /**
   * Return the webhook for this speaker, creating it if needed. Returns
   * null when the bot can't manage webhooks here OR the channel hit its
   * webhook cap — caller should fall back to bot messages in that case.
   */
  async getOrCreate(identity: SpeakerIdentity): Promise<Webhook | null> {
    const cached = this.cache.get(identity.speakerId)
    if (cached) return cached
    if (this.canManage === false) return null
    if (this.capReached.has(this.parentChannelId)) return null

    const channel = await this.client.channels.fetch(this.parentChannelId).catch(() => null)
    if (!channel || !this.isWebhookCapableTextChannel(channel)) {
      this.canManage = false
      return null
    }
    const text = channel as TextChannel

    // Look for a webhook we created in a prior op (e.g. earlier in this
    // same session if the cache was reset, or a leftover from a crashed
    // run we should reuse rather than create a duplicate).
    let webhook: Webhook | null = null
    try {
      const existing = await text.fetchWebhooks()
      this.canManage = true
      webhook = existing.find((w) => w.name === webhookName(this.recordingId, identity.speakerId)) ?? null
      if (!webhook && existing.size >= MAX_WEBHOOKS_PER_CHANNEL) {
        this.capReached.add(this.parentChannelId)
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

  private isWebhookCapableTextChannel(channel: { type: number }): boolean {
    // ChannelType.GuildText === 0; webhooks live on parent text channels.
    return channel.type === 0
  }
}
