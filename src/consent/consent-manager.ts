/**
 * ConsentManager — in-Discord button consent flow for the standalone
 * recording container.
 *
 * Phase 1's ONLY consent source: when a recording starts, the invoker (or
 * everyone in voice) is prompted via Discord buttons; a late joiner who
 * starts speaking is prompted on the spot. The manager holds the consented
 * `Set` and notifies listeners (PcmCapture + RecordingSession) when it
 * changes so a mid-session `Allow` opens that speaker's stream immediately.
 *
 * Consent semantics — opt-out by default: a user who never clicks ends up
 * NOT consented, so their audio is dropped and their captions redacted.
 *
 * Extracted from cfg-core-server's `RecordingCapability` late-joiner flow
 * (`requestLateJoinerConsent`) + `consent-collector.ts`. The DB-row +
 * persistent-consent machinery is intentionally dropped — Phase 1 keeps no
 * database; consent lives only in process memory for the session's life.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Client,
  type Interaction,
} from 'discord.js'
import type { Logger } from '../logger.js'

/**
 * Late-joiner consent window. 3 minutes — a player walking into voice
 * mid-session needs time to see the prompt and click. Matches the
 * core-server `LATE_JOINER_TIMEOUT_MS`.
 */
const LATE_JOINER_TIMEOUT_MS = 180_000

type ConsentListener = (userId: string) => void

export interface ConsentManagerParams {
  recordingId: string
  client: Client
  /**
   * Parent text channel — used as a fallback target for consent prompts
   * when the thread doesn't exist or the user can't be added to it.
   */
  textChannelId: string
  /**
   * The recording's private thread. When set, consent prompts post HERE
   * (with the late joiner first added to the thread so they can see +
   * click the buttons). Keeps the parent channel quiet and groups every
   * recording artifact — captions, mp3, consent prompts, start
   * announcement — inside the same thread.
   */
  threadId?: string | null
  /** User IDs pre-consented at start (e.g. the invoker). */
  initialConsented?: Iterable<string>
  logger: Logger
}

export class ConsentManager {
  private readonly recordingId: string
  private readonly client: Client
  private readonly textChannelId: string
  private threadId: string | null
  private readonly logger: Logger

  private readonly consented = new Set<string>()
  private readonly declined = new Set<string>()
  private readonly pending = new Set<string>()
  /** Speakers we've already seen — gates duplicate late-joiner prompts. */
  private readonly seen = new Set<string>()

  private readonly consentListeners: ConsentListener[] = []
  private readonly declineListeners: ConsentListener[] = []

  /** Bound interaction handler — retained so it can be detached on stop(). */
  private readonly interactionHandler: (interaction: Interaction) => void

  constructor(params: ConsentManagerParams) {
    this.recordingId = params.recordingId
    this.client = params.client
    this.textChannelId = params.textChannelId
    this.threadId = params.threadId ?? null
    this.logger = params.logger
    for (const id of params.initialConsented ?? []) {
      this.consented.add(id)
      this.seen.add(id)
    }
    this.interactionHandler = (interaction) => this.onInteraction(interaction)
    this.client.on('interactionCreate', this.interactionHandler)
  }

  /** True when the user has consented and their audio may be captured. */
  isConsented(userId: string): boolean {
    return this.consented.has(userId)
  }

  /** Snapshot of consented user IDs. */
  consentedIds(): Set<string> {
    return new Set(this.consented)
  }

  /** Register a callback fired when a user transitions to consented. */
  onConsent(listener: ConsentListener): void {
    this.consentListeners.push(listener)
  }

  /** Register a callback fired when a user transitions to declined. */
  onDecline(listener: ConsentListener): void {
    this.declineListeners.push(listener)
  }

  /**
   * Mark a set of users as "pending" — no prompt fires when they speak.
   * Used to pre-seed everyone in voice at start so the initial prompt
   * doesn't get double-posted via the late-joiner path.
   */
  markPending(ids: Iterable<string>): void {
    for (const id of ids) {
      if (this.consented.has(id) || this.declined.has(id)) continue
      this.pending.add(id)
      this.seen.add(id)
    }
  }

  /**
   * Note a speaker from a voice-state / speaking event. A speaker we've
   * never seen who isn't already consented/declined/pending gets a
   * late-joiner consent prompt. Idempotent.
   */
  noteSpeaker(userId: string): void {
    if (this.seen.has(userId)) return
    this.seen.add(userId)
    if (this.consented.has(userId) || this.declined.has(userId) || this.pending.has(userId)) return
    this.pending.add(userId)
    void this.requestConsent(userId)
  }

  /**
   * Post the session-start announcement INSIDE the recording thread (when
   * one was created). Discord drops its own "[bot] started a thread: ..."
   * system message in the parent channel automatically; the explicit
   * announcement in the parent would just duplicate that, so we post it
   * inside the thread instead — that's also where live captions and the
   * final mp3 land, so the message is collocated with the rest of the
   * session's surface.
   *
   * When thread creation failed earlier (`threadId === null`), fall back
   * to the parent channel so the invoker still sees the ping.
   *
   * Carries NO consent buttons — the invoker is auto-consented, and other
   * members get their own per-member prompts via {@link promptInitial} /
   * {@link noteSpeaker}. Best-effort: a failure is logged but doesn't
   * abort the session.
   */
  /**
   * Late-binding setter for the recording thread. The thread is created
   * AFTER the manager constructor runs (the controller needs the manager
   * first so it can build the recording session), so the thread id is
   * wired in once thread creation resolves. All subsequent prompts +
   * announcements target the thread when it's set.
   */
  setThreadId(threadId: string | null): void {
    this.threadId = threadId
  }

  async postSessionStart(
    invokerUserId: string,
    threadId: string | null,
    transcription: boolean,
    memberIds: string[] = [],
  ): Promise<void> {
    const kindLabel = transcription ? 'session recording with live transcription' : 'session recording'
    // Mention everyone who was in voice at start so they get a Discord
    // notification pointing them at the private thread. The invoker leads
    // the mention list; voice members follow in deduplicated order.
    const mentionIds = Array.from(
      new Set([invokerUserId, ...memberIds].filter((id) => typeof id === 'string' && id.length > 0)),
    )
    const mentions = mentionIds.map((id) => `<@${id}>`).join(' ')
    const leadMention = mentions || `<@${invokerUserId}>`
    const content = `${leadMention} starting a ${kindLabel}.`
    const target = threadId ?? this.textChannelId
    try {
      await this.sendTo(target, content, [])
    } catch (err) {
      this.logger.warn({ err, invokerUserId, recordingId: this.recordingId, target }, 'session-start announcement failed')
    }
  }

  /**
   * Post the initial consent prompt for everyone currently in voice.
   * Each user is pre-marked pending so noteSpeaker doesn't double-prompt.
   */
  async promptInitial(memberIds: string[]): Promise<void> {
    this.markPending(memberIds.filter((id) => !this.consented.has(id)))
    for (const id of memberIds) {
      if (this.consented.has(id) || this.declined.has(id)) continue
      void this.requestConsent(id)
    }
  }

  /** Detach the interaction listener. Call at session stop. */
  stop(): void {
    this.client.off('interactionCreate', this.interactionHandler)
  }

  private buildButtons(): ActionRowBuilder<ButtonBuilder>[] {
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`consent:${this.recordingId}`)
          .setLabel('Allow Recording')
          .setStyle(ButtonStyle.Success)
          .setEmoji('✅'),
        new ButtonBuilder()
          .setCustomId(`decline:${this.recordingId}`)
          .setLabel('Opt Out')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('❌'),
      ),
    ]
  }

  private async requestConsent(userId: string): Promise<void> {
    const content =
      `<@${userId}> A recording is in progress. Your audio is **not** being recorded — only audio you ` +
      'speak AFTER clicking Allow is captured. Anything before is dropped at the gate and never stored.'
    const components = this.buildButtons()

    // Prefer the private thread: it's where the captions + mp3 + start
    // announcement live, so the prompt is collocated with the artifact
    // the user is consenting to be in. Add the user to the thread first
    // so they can see + interact with the prompt — private-thread
    // messages are invisible to non-members. Falls back to the parent
    // text channel on any thread error (creation failed, perm missing,
    // member-add rejected, etc.) so the prompt always reaches them.
    const sent = await this.tryPostToThread(userId, content, components)
    if (!sent) {
      try {
        await this.sendTo(this.textChannelId, content, components)
      } catch (err) {
        this.logger.error({ err, userId, recordingId: this.recordingId }, 'consent prompt failed')
        // Can't prompt — default to declined so audio stays off.
        this.pending.delete(userId)
        this.declined.add(userId)
        return
      }
    }

    // Auto-resolve to declined after the window if the user never clicks.
    setTimeout(() => {
      if (this.pending.delete(userId)) {
        this.declined.add(userId)
        this.logger.info({ userId, recordingId: this.recordingId }, 'consent window elapsed — declined')
      }
    }, LATE_JOINER_TIMEOUT_MS).unref()
  }

  /**
   * Try to post the consent prompt inside the recording thread. Adds the
   * user to the (private) thread first so they can see + click. Returns
   * true on success, false on any failure (caller falls back to the
   * parent channel).
   */
  private async tryPostToThread(
    userId: string,
    content: string,
    components: ActionRowBuilder<ButtonBuilder>[],
  ): Promise<boolean> {
    if (!this.threadId) return false
    try {
      const channel = await this.client.channels.fetch(this.threadId)
      if (!channel || !('isThread' in channel) || !channel.isThread()) return false
      // members.add succeeds even if they're already in the thread.
      // Failure here (e.g. user left the guild) drops us to the
      // parent-channel fallback rather than failing the consent flow.
      await channel.members.add(userId).catch((err: unknown) =>
        this.logger.warn({ err, userId, threadId: this.threadId }, 'failed to add user to recording thread'),
      )
      if (!channel.isSendable()) return false
      await channel.send({ content, components })
      return true
    } catch (err) {
      this.logger.warn({ err, userId, threadId: this.threadId }, 'consent prompt thread post failed — falling back to parent channel')
      return false
    }
  }

  private async sendTo(
    channelId: string,
    content: string,
    components: ActionRowBuilder<ButtonBuilder>[],
  ): Promise<void> {
    const channel = await this.client.channels.fetch(channelId)
    if (!channel || !channel.isSendable()) {
      throw new Error(`channel ${channelId} is not sendable`)
    }
    await channel.send({ content, components })
  }

  private onInteraction(interaction: Interaction): void {
    if (!interaction.isButton()) return
    const [action, recordingId] = interaction.customId.split(':')
    if (recordingId !== this.recordingId) return
    if (action !== 'consent' && action !== 'decline') return

    const userId = interaction.user.id
    if (action === 'consent') {
      this.applyConsent(userId)
    } else {
      this.applyDecline(userId)
    }
    void interaction
      .reply({
        content: action === 'consent' ? '✅ You are now being recorded.' : '❌ Your audio will not be recorded.',
        ephemeral: true,
      })
      .catch((err) => this.logger.warn({ err, userId }, 'consent interaction reply failed'))
  }

  /**
   * Mark a user consented. Idempotent — a repeat call is a no-op and fires
   * no listeners. Public so two consent sources (Discord buttons + the
   * CFG-hosted consent-sync) can both feed this manager without either
   * needing to know about the other.
   */
  applyConsent(userId: string): void {
    this.pending.delete(userId)
    this.declined.delete(userId)
    if (this.consented.has(userId)) return
    this.consented.add(userId)
    this.seen.add(userId)
    for (const fn of this.consentListeners) {
      try {
        fn(userId)
      } catch (err) {
        this.logger.warn({ err, userId }, 'consent listener threw')
      }
    }
  }

  /**
   * Mark a user declined. Idempotent — a repeat call is a no-op and fires
   * no listeners. Public for the same two-source reason as {@link applyConsent}.
   */
  applyDecline(userId: string): void {
    this.pending.delete(userId)
    this.consented.delete(userId)
    if (this.declined.has(userId)) return
    this.declined.add(userId)
    this.seen.add(userId)
    for (const fn of this.declineListeners) {
      try {
        fn(userId)
      } catch (err) {
        this.logger.warn({ err, userId }, 'decline listener threw')
      }
    }
  }
}
