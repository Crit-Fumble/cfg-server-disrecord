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
  MessageFlags,
  type Client,
  type Interaction,
} from 'discord.js'
import type { Logger } from '../logger.js'

type ConsentListener = (userId: string) => void

export interface ConsentManagerParams {
  recordingId: string
  /**
   * Stable id encoded into the button `custom_id` so the right consent
   * handler picks up the click. In CFG-hosted mode this MUST be the
   * `installationId` (== Prisma `RecordingSession.id`) — Discord routes
   * the interaction to core-server's webhook, whose `handleConsentButton`
   * upserts `RecordingConsent` with this as the FK. A nanoid (the
   * container's local recordingId) trips the FK and Discord shows
   * "Something went wrong." In self-host mode there is no DB, no
   * webhook — the container's gateway handler is the only listener,
   * and the local recordingId works there.
   */
  buttonKey: string
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
  private readonly buttonKey: string
  private readonly client: Client
  private readonly textChannelId: string
  private threadId: string | null
  private readonly logger: Logger

  /**
   * True once the controller has told us a recording thread WILL be created
   * (via {@link expectThread}) but `threadId` isn't wired in yet — the
   * thread-creation window. A consent prompt that fires in this window is
   * QUEUED ({@link pendingThreadPrompts}) rather than posted to the parent
   * channel, then flushed into the thread by {@link setThreadId}. Distinguishes
   * "the thread is coming, just not set yet" (queue) from "this session has
   * genuinely no thread" (parent-channel fallback). Cleared once the thread is
   * set, or when thread creation is reported as failed (`setThreadId(null)`).
   */
  private threadExpected = false

  private readonly consented = new Set<string>()
  private readonly declined = new Set<string>()
  private readonly pending = new Set<string>()
  /** Speakers we've already seen — gates duplicate late-joiner prompts. */
  private readonly seen = new Set<string>()
  /**
   * User ids whose consent prompt fired during the thread-creation window
   * (thread expected, not yet set). Flushed INTO the thread by
   * {@link setThreadId} so an early speaker's prompt never leaks to the
   * parent channel. Order-preserving + deduped (re-queue is a no-op).
   */
  private readonly pendingThreadPrompts = new Set<string>()

  private readonly consentListeners: ConsentListener[] = []
  private readonly declineListeners: ConsentListener[] = []

  /** Bound interaction handler — retained so it can be detached on stop(). */
  private readonly interactionHandler: (interaction: Interaction) => void

  constructor(params: ConsentManagerParams) {
    this.recordingId = params.recordingId
    this.buttonKey = params.buttonKey
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
   * Tell the manager a recording thread IS being created but isn't wired in
   * yet. Call this BEFORE the voice listeners go live (which can trigger a
   * consent prompt) and BEFORE {@link setThreadId} resolves. While this is
   * set and `threadId` is still null, a consent prompt is QUEUED for the
   * thread instead of leaking to the parent channel; {@link setThreadId}
   * flushes the queue. Without this flag a null-thread prompt falls back to
   * the parent channel as before (the genuine no-thread case).
   */
  expectThread(): void {
    this.threadExpected = true
  }

  /**
   * Late-binding setter for the recording thread. The thread is created
   * AFTER the manager constructor runs (the controller needs the manager
   * first so it can build the recording session), so the thread id is
   * wired in once thread creation resolves. All subsequent prompts +
   * announcements target the thread when it's set.
   *
   * Resolves the thread-creation window opened by {@link expectThread}:
   *   - non-null id  → wire the thread + flush any queued prompts INTO it.
   *   - null id      → thread creation failed; the window is over, so flush
   *                    any queued prompts to the PARENT channel (the genuine
   *                    no-thread fallback) and clear the expectation.
   */
  setThreadId(threadId: string | null): void {
    this.threadId = threadId
    this.threadExpected = false
    const queued = Array.from(this.pendingThreadPrompts)
    this.pendingThreadPrompts.clear()
    // Re-issue each queued prompt now that the thread destination is known.
    // With a thread it posts in-thread; without one (creation failed) it
    // takes the parent-channel fallback — the same path a no-thread session
    // always took. `requestConsent` is idempotent at the gate via `seen`,
    // but these ids were only ADDED to `pending` (never sent), so re-issuing
    // is the first real send.
    for (const userId of queued) void this.requestConsent(userId)
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
   * to the parent channel so members still see the ping.
   *
   * CARRIES the 3-button consent row — this is the consent surface for
   * everyone in voice at start (issue #5). The invoker (when present) is
   * auto-consented but still gets a revoke button; everyone else opts in
   * here. Late joiners who weren't in voice at start get their own prompt
   * via {@link noteSpeaker}. Posted regardless of whether an invoker exists
   * (auto-started sessions have none). Returns the new message id — the
   * controller anchors the end-of-session "Back to Top" link on it.
   * Best-effort: a failure is logged, returns null, and doesn't abort the
   * session.
   */
  async postSessionStart(
    invokerUserId: string | null,
    threadId: string | null,
    transcription: boolean,
    memberIds: string[] = [],
  ): Promise<string | null> {
    const kindLabel = transcription ? 'session recording with live transcription' : 'session recording'
    // Mention everyone who was in voice at start so they get a Discord
    // notification pointing them at the private thread. The invoker (when
    // there is one — auto-started sessions have none) leads the mention
    // list; voice members follow in deduplicated order. With no invoker we
    // fall back to the voice members alone so non-speakers still get pinged
    // and the buttons-bearing announcement still posts (issue #5).
    const mentionIds = Array.from(
      new Set([invokerUserId, ...memberIds].filter((id): id is string => typeof id === 'string' && id.length > 0)),
    )
    const mentions = mentionIds.map((id) => `<@${id}>`).join(' ')
    // With mentions: "<@u1> <@u2> — starting a session recording." With
    // none (an auto-started session whose voice channel we couldn't read):
    // "Starting a session recording." — no dangling mention, still posts.
    const lead = mentions ? `${mentions} — s` : 'S'
    // Embed the 3-button consent row directly on the ping so everyone
    // sees the opt-in/opt-out controls without a separate per-member
    // prompt. This replaces the old promptInitial fan-out — that path
    // skipped anyone already pre-consented (via the session-policy seed)
    // and left them with no in-thread revoke button, which contradicted
    // the session-policy documentation. Late joiners who weren't in
    // voice at start still get their own prompt via noteSpeaker().
    const content =
      `${lead}tarting a ${kindLabel}.\n\n` +
      '🔁 **Yes, and remember** — voice is captured for this session AND future sessions in this channel.\n' +
      '✅ **Yes, this time only** — voice is captured for this session only.\n' +
      "❌ **Skip my voice** — voice isn't captured; the session continues. Click again anytime to revoke."
    const components = this.buildButtons()
    const target = threadId ?? this.textChannelId
    try {
      // Return the message id — the session-controller anchors the
      // end-of-session "Back to Top" link on this so users can jump
      // back to the start of a multi-hour transcript in one click.
      return await this.sendTo(target, content, components)
    } catch (err) {
      this.logger.warn({ err, invokerUserId, recordingId: this.recordingId, target }, 'session-start announcement failed')
      return null
    }
  }

  /**
   * Mark every voice member at session start as "seen" so the late-
   * joiner path (`noteSpeaker`) doesn't fire a duplicate per-member
   * prompt the first time they speak. The actual consent prompt for
   * these users is the 3-button row embedded on the session-start
   * announcement posted by {@link postSessionStart}; no per-member
   * fan-out is needed.
   *
   * Late joiners who weren't in voice at start (and therefore aren't
   * in this set) still get their own prompt via `noteSpeaker` the
   * first time they speak.
   */
  async promptInitial(memberIds: string[]): Promise<void> {
    // Seed `seen` for every member-at-start (pre-consented or not) so
    // noteSpeaker is a no-op for them. The 3-button row on the
    // session-start announcement is their consent prompt; we don't want
    // a duplicate per-member prompt the first time they speak.
    for (const id of memberIds) {
      this.seen.add(id)
      if (!this.consented.has(id) && !this.declined.has(id)) this.pending.add(id)
    }
  }

  /** Detach the interaction listener. Call at session stop. */
  stop(): void {
    this.client.off('interactionCreate', this.interactionHandler)
  }

  private buildButtons(): ActionRowBuilder<ButtonBuilder>[] {
    // Three-button consent layout. `buttonKey` is installationId in
    // CFG-hosted (matches the RecordingConsent FK) and the local
    // recordingId in self-host (matches the gateway-side handler).
    //
    // Order = visual weight:
    //   1. "Yes, and remember"   PRIMARY  — Success/green, default action
    //   2. "Yes, this time only" SECONDARY — Primary/blue
    //   3. "Skip my voice"       TERTIARY  — Danger/red
    //
    // core-server's handleConsentButton already routes the three customId
    // prefixes (`consent_remember:`, `consent:`, `decline:`) — only the
    // remember variant writes persistent opt-in via recordInSessionOptIn.
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`consent_remember:${this.buttonKey}`)
          .setLabel('Yes, and remember')
          .setStyle(ButtonStyle.Success)
          .setEmoji('🔁'),
        new ButtonBuilder()
          .setCustomId(`consent:${this.buttonKey}`)
          .setLabel('Yes, this time only')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('✅'),
        new ButtonBuilder()
          .setCustomId(`decline:${this.buttonKey}`)
          .setLabel('Skip my voice')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('❌'),
      ),
    ]
  }

  private async requestConsent(userId: string): Promise<void> {
    // Thread-creation window: a thread WILL exist but isn't wired in yet.
    // Queue this prompt instead of leaking it to the parent channel — it's
    // flushed into the thread (or the parent, if creation failed) once
    // setThreadId resolves. `pending` already holds the user (set by the
    // caller), so audio stays gated as redacted until they decide.
    if (!this.threadId && this.threadExpected) {
      this.pendingThreadPrompts.add(userId)
      return
    }

    const content =
      `<@${userId}> 🎙 A session recording is in progress.\n\n` +
      '🔁 **Yes, and remember** — your voice is in the recording, transcript, and captions, AND skip ' +
      'this prompt for future sessions in this channel.\n' +
      '✅ **Yes, this time only** — your voice is in the recording, transcript, and captions, this session only.\n' +
      "❌ **Skip my voice** — your voice isn't captured; the session continues normally. Won't re-prompt.\n\n" +
      'You can change your choice any time while recording is live — in-session via these buttons, or ' +
      "anytime via your account's recording-consent page. Only audio you speak AFTER clicking is " +
      'captured; anything before is dropped at the gate and never stored.'
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

    // No auto-decline timeout. The user can click Allow / Opt Out any
    // time during the session — pending stays pending (i.e. audio gated
    // as redacted) until they explicitly decide. The previous 3-min
    // window would silently flip a "not yet decided" user to declined,
    // which surfaced as "I clicked Allow and nothing happened" when the
    // click landed just after the window elapsed.
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
  ): Promise<string> {
    const channel = await this.client.channels.fetch(channelId)
    if (!channel || !channel.isSendable()) {
      throw new Error(`channel ${channelId} is not sendable`)
    }
    const msg = await channel.send({ content, components })
    return msg.id
  }

  private onInteraction(interaction: Interaction): void {
    if (!interaction.isButton()) return
    const [action, key] = interaction.customId.split(':')
    if (key !== this.buttonKey) return
    // `consent_remember` collapses to the same applyConsent on the
    // container side — the persistent opt-in DB write is core-server's
    // job in handleConsentButton. Both grant audio for THIS session.
    const normalized = action === 'consent_remember' ? 'consent' : action
    if (normalized !== 'consent' && normalized !== 'decline') return
    void this.handleConsentInteraction(interaction, normalized as 'consent' | 'decline')
  }

  /**
   * Defer the interaction reply FIRST (Discord's 3s ACK window is easy
   * to miss when applyConsent's downstream work — opening a Deepgram
   * stream, emitting a [redacted] placeholder — drags the event loop).
   * Then do the work, then editReply with the result. The user always
   * sees a real confirmation instead of Discord's generic "Something
   * went wrong" ephemeral.
   */
  private async handleConsentInteraction(
    interaction: Interaction,
    action: 'consent' | 'decline',
  ): Promise<void> {
    if (!interaction.isButton()) return
    const userId = interaction.user.id
    this.logger.info(
      { recordingId: this.recordingId, userId, action },
      'consent button clicked — deferring reply',
    )

    // Ephemeral defer. Microsecond-fast, ack's Discord well within the 3s
    // window even if the bot is under load.
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    } catch (err) {
      this.logger.warn({ err, userId, recordingId: this.recordingId }, 'consent deferReply failed')
      // Without a successful ack the user sees "Something went wrong".
      // Still apply the consent state so audio gating is correct even if
      // the user got no confirmation.
      if (action === 'consent') this.applyConsent(userId)
      else this.applyDecline(userId)
      return
    }

    try {
      if (action === 'consent') {
        this.applyConsent(userId)
        this.logger.info({ recordingId: this.recordingId, userId }, 'consent applied (allow)')
      } else {
        this.applyDecline(userId)
        this.logger.info({ recordingId: this.recordingId, userId }, 'consent applied (decline)')
      }
    } catch (err) {
      this.logger.error({ err, userId, recordingId: this.recordingId }, 'applyConsent threw')
    }

    try {
      await interaction.editReply({
        content:
          action === 'consent'
            ? '✅ You are now being recorded.'
            : '❌ Your audio will not be recorded.',
      })
    } catch (err) {
      this.logger.warn({ err, userId, recordingId: this.recordingId }, 'consent editReply failed')
    }
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
