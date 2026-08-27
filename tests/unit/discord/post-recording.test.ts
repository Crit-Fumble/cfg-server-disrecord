/**
 * postRecording's boolean result (cs#352).
 *
 * The return value feeds the "recording artifact landed in Discord"
 * report-back to core-server, which suppresses the duplicate forum-post
 * artifact link. The invariant: `true` ONLY when every part uploaded;
 * every early exit (unsendable target, split failure, part-upload
 * failure) is `false` — a partial multi-part upload must never read as
 * delivered.
 */

// Force the split path to fail deterministically — the real splitter
// shells out to ffmpeg, which a unit test must not depend on. Everything
// else (constants, pause finders, planner) stays real via requireActual.
jest.mock('../../../src/recording/audio-splitter.js', () => ({
  ...jest.requireActual('../../../src/recording/audio-splitter.js'),
  splitMp3AtBreakpoints: jest.fn(async () => {
    throw new Error('split failed (test)')
  }),
}))

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { postRecording } from '../../../src/discord/thread-poster.js'
import { DISCORD_MAX_PART_BYTES } from '../../../src/recording/audio-splitter.js'
import type { PostProcessResult } from '../../../src/recording/post-process.js'
import type { CaptionEntry } from '../../../src/recording/caption-types.js'

const silentLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as never

/** Discord client stub whose channels.fetch resolves `channel`. */
function clientWith(channel: unknown) {
  return { channels: { fetch: jest.fn(async () => channel) } } as never
}

function sendableChannel(send: jest.Mock = jest.fn(async () => ({ id: 'msg-1' }))) {
  return { isSendable: () => true, send }
}

let tempDir: string
let mp3Path: string

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'disrecord-post-recording-'))
  mp3Path = join(tempDir, 'rec.mp3')
  await writeFile(mp3Path, Buffer.from('mp3-bytes'))
})

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

function smallResult(): PostProcessResult {
  return {
    mp3Path,
    sizeBytes: 9, // matches the fixture file; well under the part cap
    durationMs: 60_000,
    captions: [],
    mp3Location: mp3Path,
  }
}

describe('postRecording result (cs#352)', () => {
  it('returns true when every part posted (single-part path)', async () => {
    const send = jest.fn(async () => ({ id: 'msg-1' }))
    const posted = await postRecording(
      clientWith(sendableChannel(send)),
      'thread-1',
      'rec-1',
      tempDir,
      smallResult(),
      [],
      new Set<string>(),
      silentLogger,
    )
    expect(posted).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('returns false when the target is not sendable, without sending anything', async () => {
    const posted = await postRecording(
      clientWith(null),
      'thread-1',
      'rec-1',
      tempDir,
      smallResult(),
      [],
      new Set<string>(),
      silentLogger,
    )
    expect(posted).toBe(false)
  })

  it('returns false when a part upload fails', async () => {
    const send = jest.fn(async () => {
      throw new Error('413 payload too large (test)')
    })
    const posted = await postRecording(
      clientWith(sendableChannel(send)),
      'thread-1',
      'rec-1',
      tempDir,
      smallResult(),
      [],
      new Set<string>(),
      silentLogger,
    )
    expect(posted).toBe(false)
  })

  it('returns false when splitting an over-cap mp3 fails', async () => {
    const send = jest.fn(async () => ({ id: 'msg-1' }))
    // Two captions with a real gap: the pause finder runs off caption data,
    // keeping ffmpeg's silencedetect out of the unit test entirely.
    const captions: CaptionEntry[] = [
      { speakerName: 'A', speakerId: 'u1', transcript: 'hello', startSec: 0, endSec: 5 },
      { speakerName: 'B', speakerId: 'u2', transcript: 'world', startSec: 20, endSec: 25 },
    ]
    const posted = await postRecording(
      clientWith(sendableChannel(send)),
      'thread-1',
      'rec-1',
      tempDir,
      { ...smallResult(), sizeBytes: DISCORD_MAX_PART_BYTES + 1, captions },
      captions,
      new Set<string>(),
      silentLogger,
    )
    expect(posted).toBe(false)
    // Only the "too large to embed" notice went out — no recording part did.
    expect(send).toHaveBeenCalledTimes(1)
  })
})
