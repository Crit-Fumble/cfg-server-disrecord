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
 * id, or null when creation fails — the caller MUST treat null as "do
 * not deliver to Discord", not as a license to post in the parent
 * channel. Posting a recording publicly is a privacy violation regardless
 * of which container surface (thread vs channel) carries it.
 *
 * Private threads keep the session's audio + transcript out of the
 * parent channel's history for anyone who wasn't in the call. Recordings
 * include consenting speakers only, but limiting *visibility* of the
 * artifact to call participants is a separate privacy axis we never
 * downgrade automatically.
 *
 * Tries `invitable:false` first (needs `ManageThreads`), then plain
 * private (needs `CreatePrivateThreads`). NO public-thread fallback —
 * if both fail, returns null and the recording stays in object storage
 * for out-of-band retrieval.
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

    // Try private + invitable:false (best privacy, needs ManageThreads).
    // Then plain private (only needs CreatePrivateThreads — the common
    // case for skill-server bots that aren't moderators). If both fail
    // we return null — NO public-thread fallback. The recording is
    // already in object storage; failing the Discord post is the only
    // safe outcome when we can't guarantee thread privacy.
    let thread
    try {
      thread = await (channel as TextChannel).threads.create({
        name: threadName,
        autoArchiveDuration: 1440,
        type: ChannelType.PrivateThread,
        invitable: false,
      })
    } catch (privateLockedErr) {
      logger.warn(
        { err: privateLockedErr, textChannelId },
        'private thread w/ invitable:false failed (bot likely lacks ManageThreads) — retrying without invitable:false',
      )
      thread = await (channel as TextChannel).threads.create({
        name: threadName,
        autoArchiveDuration: 1440,
        type: ChannelType.PrivateThread,
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

/** Format a second offset as `mm:ss` for chunk headers. */
function mmss(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Upload one real-time recording chunk (#131) into `channelId` — a bite-sized
 * mp3 posted mid-session so players can catch up on what they missed without
 * waiting for the whole session to end. Best-effort: a failed send is logged,
 * never thrown (the whole-session mp3 still carries this span at stop()).
 */
export async function postChunk(
  client: Client,
  channelId: string,
  recordingId: string,
  info: { mp3Path: string; index: number; startSec: number; endSec: number; sizeBytes: number },
  logger: Logger,
): Promise<string | null> {
  const channel = await client.channels.fetch(channelId).catch(() => null)
  if (!channel || !channel.isSendable()) {
    logger.warn({ channelId, recordingId, index: info.index }, 'chunk target not sendable — chunk not posted')
    return null
  }
  try {
    const data = await readFile(info.mp3Path)
    const partNumber = String(info.index + 1).padStart(2, '0')
    const sizeMb = (info.sizeBytes / 1_048_576).toFixed(1)
    const header = `🎧 **Live chunk ${partNumber}** — ${mmss(info.startSec)}–${mmss(info.endSec)} (${sizeMb} MB)`
    const name = `chunk-${recordingId}-${partNumber}.mp3`
    const message = await (channel as GuildTextBasedChannel).send({
      content: header,
      files: [new AttachmentBuilder(data, { name })],
    })
    logger.info({ recordingId, channelId, index: info.index }, 'live chunk posted to thread')
    return message.id
  } catch (err) {
    logger.warn({ err, recordingId, index: info.index }, 'failed to post live chunk (non-fatal)')
    return null
  }
}

/** Resolve the temp dir for a finalized result (sibling of the mp3). */
export function tempDirOf(mp3Path: string): string {
  return join(mp3Path, '..')
}
