/**
 * SessionController — per-recording orchestrator for the standalone container.
 *
 * Owns one recording's full lifecycle: a {@link VoiceCapture} (Discord voice
 * connection), a {@link PcmCapture} (mp3-mix disk writer), a
 * {@link RecordingSession} (per-speaker Deepgram transcription), and a
 * {@link ConsentManager} (in-Discord button consent). Replaces core-server's
 * `disrecord/index.ts` role for a single session.
 *
 * Lifecycle:
 *   start()  → mkdir temp → join voice → post initial consent prompt
 *   pause()  → gate audio + transcription
 *   resume() → un-gate
 *   stop()   → leave voice → finalize PCM → mix → VTT → sink → post thread
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Client } from 'discord.js'
import { VoiceCapture } from '../gateway/voice-capture.js'
import { PcmCapture } from './pcm-capture.js'
import { RecordingSession, type TranscriptFinalEvent } from '../worker/recording-session.js'
import { ConsentManager } from '../consent/consent-manager.js'
import { processRecording } from './post-process.js'
import { createRecordingThread, postRecording, tempDirOf } from '../discord/thread-poster.js'
import type { OutputSink } from './output-sink.js'
import type { CaptionEntry } from './caption-types.js'
import type { Logger } from '../logger.js'

export type SessionStatus = 'starting' | 'recording' | 'paused' | 'stopping' | 'stopped' | 'failed'

export interface SessionControllerParams {
  recordingId: string
  client: Client
  guildId: string
  voiceChannelId: string
  /** Text channel for the thread + consent prompt. Defaults to voice channel. */
  textChannelId: string
  /** Whether live transcription is enabled. */
  transcription: boolean
  /** Deepgram API key. Null disables transcription regardless of `transcription`. */
  deepgramKey: string | null
  deepgramModel: string
  deepgramLanguage: string
  /** Output sink for the finalized mp3 + VTT. */
  sink: OutputSink
  /** Discord user id of the invoker — pre-consented. */
  invokerUserId?: string
  logger: Logger
}

export class SessionController {
  public readonly recordingId: string
  public readonly guildId: string
  public readonly voiceChannelId: string
  public readonly startedAt = Date.now()

  private status: SessionStatus = 'starting'
  private readonly logger: Logger
  private readonly params: SessionControllerParams

  private tempDir = ''
  private consent!: ConsentManager
  private pcmCapture!: PcmCapture
  private session!: RecordingSession
  private voice!: VoiceCapture
  private readonly captions: CaptionEntry[] = []
  private threadId: string | null = null

  constructor(params: SessionControllerParams) {
    this.params = params
    this.recordingId = params.recordingId
    this.guildId = params.guildId
    this.voiceChannelId = params.voiceChannelId
    this.logger = params.logger
  }

  /** Build the pipeline, join voice, and post the initial consent prompt. */
  async start(): Promise<void> {
    const p = this.params
    this.tempDir = await mkdtemp(join(tmpdir(), `disrecord-${this.recordingId}-`))

    this.consent = new ConsentManager({
      recordingId: this.recordingId,
      client: p.client,
      textChannelId: p.textChannelId,
      mirrorChannelId: p.textChannelId !== p.voiceChannelId ? p.voiceChannelId : undefined,
      initialConsented: p.invokerUserId ? [p.invokerUserId] : [],
      logger: this.logger,
    })

    this.pcmCapture = new PcmCapture({
      recordingId: this.recordingId,
      tempDir: this.tempDir,
      consent: this.consent,
      logger: this.logger,
    })

    const deepgramKey = p.transcription ? p.deepgramKey : null
    this.session = new RecordingSession({
      deepgramApiKey: deepgramKey,
      deepgramModel: p.deepgramModel,
      language: p.deepgramLanguage,
      consentedUserIds: this.consent.consentedIds(),
      resolveSpeakerName: (userId) => this.resolveSpeakerName(userId),
      onTranscriptFinal: (event: TranscriptFinalEvent) => this.onTranscript(event),
      logger: this.logger,
    })
    // Keep the RecordingSession consent set in sync with the manager.
    this.consent.onConsent((userId) => void this.session.addConsentedUser(userId))
    this.consent.onDecline((userId) => this.session.addDeclinedUser(userId))

    this.voice = new VoiceCapture({
      client: p.client,
      guildId: p.guildId,
      voiceChannelId: p.voiceChannelId,
      session: this.session,
      pcmCapture: this.pcmCapture,
      consent: this.consent,
      logger: this.logger,
    })
    await this.voice.join()

    // Prompt everyone currently in the voice channel.
    const memberIds = await this.voiceMemberIds(p.client)
    await this.consent.promptInitial(memberIds)

    this.status = 'recording'
    this.logger.info(
      { recordingId: this.recordingId, guildId: this.guildId, transcription: deepgramKey != null },
      'recording session started',
    )
  }

  pause(): void {
    if (this.status !== 'recording') return
    this.status = 'paused'
    this.pcmCapture.setPaused(true)
    this.session.setPaused(true)
    this.logger.info({ recordingId: this.recordingId }, 'recording paused')
  }

  resume(): void {
    if (this.status !== 'paused') return
    this.status = 'recording'
    this.pcmCapture.setPaused(false)
    this.session.setPaused(false)
    this.logger.info({ recordingId: this.recordingId }, 'recording resumed')
  }

  /**
   * Stop the session: leave voice, finalize PCM, mix mp3, generate VTT,
   * store via the sink, and post the result into Discord. Runs to
   * completion — callers that need a fast HTTP response should not await it.
   */
  async stop(): Promise<void> {
    if (this.status === 'stopped' || this.status === 'stopping') return
    this.status = 'stopping'
    this.logger.info({ recordingId: this.recordingId }, 'recording stopping')

    this.consent.stop()
    this.voice.leave('session-stop')
    await this.pcmCapture.onSessionStop()
    await this.session.stop()

    try {
      const result = await processRecording(
        this.recordingId,
        this.pcmCapture.getResult(),
        this.params.sink,
        {
          guildId: this.guildId,
          voiceChannelId: this.voiceChannelId,
          durationMs: Date.now() - this.startedAt,
          speakerCount: this.pcmCapture.speakerCount,
          transcription: this.params.transcription,
        },
        this.logger,
        {
          captions: this.captions.length > 0 ? this.captions : undefined,
          redactedSpeakerIds: this.redactedSpeakerIds(),
        },
      )
      if (result) {
        await this.deliver(result)
      } else {
        this.logger.warn({ recordingId: this.recordingId }, 'nothing recorded — no output produced')
      }
    } catch (err) {
      this.status = 'failed'
      this.logger.error({ err, recordingId: this.recordingId }, 'post-processing failed')
    } finally {
      await rm(this.tempDir, { recursive: true, force: true }).catch(() => {})
      if (this.status !== 'failed') this.status = 'stopped'
      this.logger.info({ recordingId: this.recordingId }, 'recording session stopped')
    }
  }

  /** Snapshot for the control API. */
  describe(): {
    recordingId: string
    guildId: string
    voiceChannelId: string
    status: SessionStatus
    startedAt: number
    speakerCount: number
    paused: boolean
  } {
    return {
      recordingId: this.recordingId,
      guildId: this.guildId,
      voiceChannelId: this.voiceChannelId,
      status: this.status,
      startedAt: this.startedAt,
      speakerCount: this.pcmCapture?.speakerCount ?? 0,
      paused: this.status === 'paused',
    }
  }

  private async deliver(result: Awaited<ReturnType<typeof processRecording>>): Promise<void> {
    if (!result) return
    const p = this.params
    const voiceChannelName = await this.voiceChannelName(p.client)
    this.threadId = await createRecordingThread(
      p.client,
      p.textChannelId,
      voiceChannelName,
      p.transcription,
      this.logger,
    )
    const target = this.threadId ?? p.textChannelId
    await postRecording(
      p.client,
      target,
      this.recordingId,
      tempDirOf(result.mp3Path),
      result,
      result.captions,
      this.redactedSpeakerIds(),
      this.logger,
    )
  }

  private onTranscript(event: TranscriptFinalEvent): void {
    this.captions.push({
      speakerName: event.speakerName,
      speakerId: event.speakerId,
      transcript: event.transcript,
      words: event.words,
      startSec: event.startSec,
      endSec: event.endSec,
    })
  }

  private redactedSpeakerIds(): Set<string> {
    const consented = this.consent.consentedIds()
    const redacted = new Set<string>()
    for (const c of this.captions) {
      if (!consented.has(c.speakerId)) redacted.add(c.speakerId)
    }
    return redacted
  }

  private async resolveSpeakerName(userId: string): Promise<string> {
    try {
      const user = await this.params.client.users.fetch(userId)
      return user.displayName || user.username || userId
    } catch {
      return userId
    }
  }

  private async voiceMemberIds(client: Client): Promise<string[]> {
    try {
      const channel = await client.channels.fetch(this.voiceChannelId)
      if (channel && channel.isVoiceBased()) {
        return Array.from(channel.members.keys()).filter((id) => id !== client.user?.id)
      }
    } catch {
      /* fall through */
    }
    return []
  }

  private async voiceChannelName(client: Client): Promise<string> {
    try {
      const channel = await client.channels.fetch(this.voiceChannelId)
      if (channel && 'name' in channel && channel.name) return channel.name
    } catch {
      /* fall through */
    }
    return this.voiceChannelId
  }
}
