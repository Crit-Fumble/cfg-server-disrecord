/**
 * Thread Poster — creates a Discord thread for a recording and uploads the
 * finalized mp3 + VTT into it, chunking when the mp3 is over Discord's
 * upload cap.
 *
 * Ported from cfg-core-server's thread-creation block in `recording-handler.ts`
 * + the chunked-upload flow in `discord-delivery.ts`. Uses the container's own
 * discord.js client (no REST-token plumbing — discord.js handles it).
 */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AttachmentBuilder,
  ChannelType,
  type Client,
  type GuildTextBasedChannel,
  type TextChannel,
} from 'discord.js'
import {
  DISCORD_MAX_PART_BYTES,
  MIN_SEGMENT_SECONDS,
  findPausesFromCaptions,
  findPausesFromSilenceDetect,
  planSplitPoints,
  splitMp3AtBreakpoints,
} from '../recording/audio-splitter.js'
import { generateVtt } from '../recording/vtt-generator.js'
import type { CaptionEntry } from '../recording/caption-types.js'
import type { PostProcessResult } from '../recording/post-process.js'
import type { Logger } from '../logger.js'

/**
 * Create a PRIVATE thread under `textChannelId` for a recording and invite
 * every member who was in voice at session start so they (and only they)
 * can see the live transcript + final recording. Returns the new thread's
 * id, or null when creation fails (caller falls back to posting in the
 * parent channel).
 *
 * Private threads keep the session's audio + transcript out of the
 * parent channel's history for anyone who wasn't in the call — useful
 * for sessions with sensitive content (recordings include consenting
 * speakers only, but limiting *visibility* of the artifact to call
 * participants is a separate privacy axis).
 *
 * Falls back to a public thread on any private-thread error (e.g. the
 * server has private threads disabled): better to deliver the artifact
 * than to fail the session over a thread-visibility downgrade. The
 * caller's `postSessionStart` ping still notifies the invitee list.
 */
export async function createRecordingThread(
  client: Client,
  textChannelId: string,
  voiceChannelName: string,
  transcription: boolean,
  memberIds: string[],
  logger: Logger,
): Promise<string | null> {
  try {
    const channel = await client.channels.fetch(textChannelId)
    if (!channel || channel.type !== ChannelType.GuildText) {
      logger.warn({ textChannelId }, 'thread parent is not a standard text channel — posting in channel')
      return null
    }
    const dateStr = new Date().toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
    const kindLabel = transcription ? 'Transcription' : 'Recording'
    const rawName = `${voiceChannelName} - ${dateStr} - ${kindLabel}`
    const threadName = rawName.length > 100 ? rawName.slice(0, 100) : rawName

    let thread
    try {
      thread = await (channel as TextChannel).threads.create({
        name: threadName,
        autoArchiveDuration: 1440,
        type: ChannelType.PrivateThread,
        invitable: false,
      })
    } catch (privateErr) {
      logger.warn(
        { err: privateErr, textChannelId },
        'private thread creation failed — falling back to public thread',
      )
      thread = await (channel as TextChannel).threads.create({
        name: threadName,
        autoArchiveDuration: 1440,
      })
    }

    // Invite every voice member so they have access to the (private) thread.
    // Best-effort per user — one bad id (e.g. left the guild between
    // session start and thread create) shouldn't fail the others.
    const unique = Array.from(new Set(memberIds.filter((id) => typeof id === 'string' && id.length > 0)))
    if (unique.length > 0) {
      await Promise.all(
        unique.map((userId) =>
          thread.members.add(userId).catch((err: unknown) =>
            logger.warn({ err, userId, threadId: thread.id }, 'failed to add member to recording thread'),
          ),
        ),
      )
    }

    logger.info(
      { threadId: thread.id, threadName, type: thread.type, memberCount: unique.length },
      'recording thread created',
    )
    return thread.id
  } catch (err) {
    logger.warn({ err, textChannelId }, 'thread creation failed — posting in channel')
    return null
  }
}

/**
 * Upload a finalized recording (mp3 + optional VTT) into `channelId`,
 * splitting the mp3 into Discord-uploadable parts when it's over the cap.
 */
export async function postRecording(
  client: Client,
  channelId: string,
  recordingId: string,
  tempDir: string,
  result: PostProcessResult,
  captions: CaptionEntry[],
  redactedSpeakerIds: Set<string>,
  logger: Logger,
): Promise<void> {
  const channel = await client.channels.fetch(channelId).catch(() => null)
  if (!channel || !channel.isSendable()) {
    logger.warn({ channelId, recordingId }, 'post target not sendable — recording not posted')
    return
  }

  const totalDurationSec = result.durationMs / 1000
  let parts: string[]
  const partRanges: Array<{ startSec: number; endSec: number }> = []

  if (result.sizeBytes > DISCORD_MAX_PART_BYTES) {
    const bytesPerSec = result.sizeBytes / totalDurationSec
    const rawSegmentSec = (DISCORD_MAX_PART_BYTES * 0.9) / bytesPerSec
    const targetSegmentSec = Math.max(MIN_SEGMENT_SECONDS, Math.floor(rawSegmentSec))

    let pauses: Array<{ startSec: number; endSec: number; durationSec: number }> = []
    if (captions.length >= 2) {
      pauses = findPausesFromCaptions(captions)
    } else {
      try {
        pauses = await findPausesFromSilenceDetect(result.mp3Path, recordingId)
      } catch (err) {
        logger.warn({ err, recordingId }, 'silencedetect failed — splitting at hard targets only')
      }
    }

    const breakpoints = planSplitPoints(totalDurationSec, targetSegmentSec, pauses)
    try {
      parts = await splitMp3AtBreakpoints(result.mp3Path, tempDir, breakpoints, recordingId)
      let prev = 0
      for (const bp of breakpoints) {
        partRanges.push({ startSec: prev, endSec: bp })
        prev = bp
      }
      partRanges.push({ startSec: prev, endSec: totalDurationSec })
      logger.info({ recordingId, partCount: parts.length }, 'recording split for Discord upload')
    } catch (err) {
      logger.error({ err, recordingId }, 'failed to split large recording')
      await (channel as GuildTextBasedChannel).send(
        `**Recording too large to embed** — recording id \`${recordingId}\` (${(result.sizeBytes / 1_048_576).toFixed(1)} MB).`,
      )
      return
    }
  } else {
    parts = [result.mp3Path]
    partRanges.push({ startSec: 0, endSec: totalDurationSec })
  }

  const durationMin = Math.round(result.durationMs / 60_000)
  const total = parts.length

  for (let i = 0; i < parts.length; i++) {
    const partPath = parts[i]
    const partStat = await stat(partPath)
    const partSizeMb = (partStat.size / 1_048_576).toFixed(1)
    const data = await readFile(partPath)

    const header =
      total === 1
        ? `**Session recording** — ${durationMin}m, ${partSizeMb} MB`
        : `**Session recording** — Part ${i + 1} of ${total} (${partSizeMb} MB, total ${durationMin}m)`

    const partNumber = String(i + 1).padStart(2, '0')
    const totalNumber = String(total).padStart(2, '0')
    const mp3Name =
      total === 1
        ? `session-${recordingId}.mp3`
        : `session-${recordingId}-part-${partNumber}-of-${totalNumber}.mp3`

    const files: AttachmentBuilder[] = [new AttachmentBuilder(data, { name: mp3Name })]

    if (captions.length > 0) {
      const range = partRanges[i]
      if (range) {
        const vttContent = generateVtt(captions, redactedSpeakerIds, {
          offsetSec: range.startSec,
          lengthSec: range.endSec - range.startSec,
        })
        if (vttContent.trim() !== 'WEBVTT') {
          const vttName =
            total === 1
              ? `session-${recordingId}.vtt`
              : `session-${recordingId}-part-${partNumber}-of-${totalNumber}.vtt`
          files.push(new AttachmentBuilder(Buffer.from(vttContent, 'utf-8'), { name: vttName }))
        }
      }
    }

    try {
      await (channel as GuildTextBasedChannel).send({ content: header, files })
    } catch (err) {
      logger.error({ err, recordingId, part: i + 1, total }, 'failed to upload recording part')
      await (channel as GuildTextBasedChannel)
        .send(`**Recording part ${i + 1} too large** — recording id \`${recordingId}\`.`)
        .catch(() => {})
      return
    }
  }
  logger.info({ recordingId, channelId, total }, 'recording posted to Discord')
}

/** Resolve the temp dir for a finalized result (sibling of the mp3). */
export function tempDirOf(mp3Path: string): string {
  return join(mp3Path, '..')
}
