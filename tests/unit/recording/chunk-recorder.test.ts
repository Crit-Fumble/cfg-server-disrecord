/**
 * ChunkRecorder pure-logic unit tests (#131).
 *
 * The load-bearing correctness of real-time chunking is the byte-window math:
 * mapping a wall-clock window [startByte, endByte) of a speaker's silence-padded,
 * rotation-split PCM stream to per-file read slices. If this drifts, chunks
 * desync or duplicate/skip audio. These tests pin it; the mix + upload are
 * exercised against the live-record harness (out of unit scope).
 */

import { planWindowReads, evenFloor, type FileSpan } from '../../../src/recording/chunk-recorder.js'

describe('evenFloor', () => {
  it('rounds down to an even byte boundary (s16le sample = 2 bytes)', () => {
    expect(evenFloor(0)).toBe(0)
    expect(evenFloor(10)).toBe(10)
    expect(evenFloor(11)).toBe(10)
    expect(evenFloor(1)).toBe(0)
  })
  it('never returns negative', () => {
    expect(evenFloor(-5)).toBe(0)
  })
  it('floors fractional input first', () => {
    expect(evenFloor(9.9)).toBe(8)
  })
})

describe('planWindowReads', () => {
  const files: FileSpan[] = [
    { path: 'a-000.pcm', size: 100 },
    { path: 'a-001.pcm', size: 100 },
    { path: 'a-002.pcm', size: 60 }, // concatenated timeline: [0,100) [100,200) [200,260)
  ]

  it('reads a window fully inside the first file', () => {
    expect(planWindowReads(files, 10, 40)).toEqual([{ path: 'a-000.pcm', offset: 10, length: 30 }])
  })

  it('splits a window that spans a rotation boundary into per-file slices', () => {
    // [80,140) → last 20 bytes of file0 + first 40 bytes of file1
    expect(planWindowReads(files, 80, 140)).toEqual([
      { path: 'a-000.pcm', offset: 80, length: 20 },
      { path: 'a-001.pcm', offset: 0, length: 40 },
    ])
  })

  it('spans three files when the window is long enough', () => {
    // [50,230) → file0[50,100) + file1[0,100) + file2[0,30)
    expect(planWindowReads(files, 50, 230)).toEqual([
      { path: 'a-000.pcm', offset: 50, length: 50 },
      { path: 'a-001.pcm', offset: 0, length: 100 },
      { path: 'a-002.pcm', offset: 0, length: 30 },
    ])
  })

  it('truncates a window that runs past the end of available data', () => {
    // total on-disk = 260; ask up to 400 → capped at 260
    expect(planWindowReads(files, 240, 400)).toEqual([{ path: 'a-002.pcm', offset: 40, length: 20 }])
  })

  it('returns nothing when the window starts past all available data (speaker silent this window)', () => {
    expect(planWindowReads(files, 300, 400)).toEqual([])
  })

  it('returns nothing for an empty or inverted window', () => {
    expect(planWindowReads(files, 100, 100)).toEqual([])
    expect(planWindowReads(files, 150, 100)).toEqual([])
  })

  it('handles a window that begins exactly on a file boundary', () => {
    expect(planWindowReads(files, 100, 160)).toEqual([{ path: 'a-001.pcm', offset: 0, length: 60 }])
  })

  it('handles an empty file list', () => {
    expect(planWindowReads([], 0, 100)).toEqual([])
  })

  it('skips a leading empty (rotated-away) file without shifting later offsets', () => {
    const withEmpty: FileSpan[] = [
      { path: 'a-000.pcm', size: 0 },
      { path: 'a-001.pcm', size: 100 },
    ]
    // timeline: file0 occupies [0,0) (nothing), file1 [0,100)
    expect(planWindowReads(withEmpty, 10, 50)).toEqual([{ path: 'a-001.pcm', offset: 10, length: 40 }])
  })
})

// ── The redundant-final-chunk guard (owner report, 2026-08-07) ──────────────
//
// A session shorter than one chunk window used to end as TWO identical mp3s in
// the thread: the `final` flush (chunk 01, spanning the whole session) plus the
// whole-session mp3. The guard skips the final cut only when its window still
// starts at byte 0 — i.e. no interval/pause cut ever advanced the cursor.

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import { ChunkRecorder } from '../../../src/recording/chunk-recorder.js'

jest.mock('../../../src/recording/ffmpeg.js', () => ({
  buildFfmpegArgs: jest.fn((_files: unknown, outPath: string) => [outPath]),
  runFfmpeg: jest.fn(async (args: string[]) => {
    await (await import('node:fs/promises')).writeFile(args[0], Buffer.alloc(64))
  }),
}))

const quietLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as never

describe('ChunkRecorder final-flush guard', () => {
  async function makeRecorder(timeline: () => number, postChunk: jest.Mock) {
    const tempDir = await mkdtemp(joinPath(tmpdir(), 'chunk-guard-'))
    const pcmPath = joinPath(tempDir, 'user-000.pcm')
    await writeFile(pcmPath, Buffer.alloc(32_000))
    return new ChunkRecorder({
      recordingId: 'guard-test',
      chunkMinutes: 10,
      tempDir,
      getSpeakerFiles: () => new Map([['user', [pcmPath]]]),
      timelineByteNow: timeline,
      postChunk: postChunk as never,
      logger: quietLogger,
    })
  }

  it('skips the final cut when no interval cut ever ran — the session mp3 already carries it', async () => {
    const postChunk = jest.fn(async () => {})
    const recorder = await makeRecorder(() => 32_000, postChunk)
    await recorder.finalize()
    expect(postChunk).not.toHaveBeenCalled()
  })

  it('still posts the final cut when an earlier window advanced the cursor', async () => {
    const postChunk = jest.fn(async () => {})
    let now = 16_000
    const recorder = await makeRecorder(() => now, postChunk)
    // onResume() advances the window cursor exactly like an interval cut
    // having run — the session outlived its first window.
    recorder.onResume()
    now = 32_000
    await recorder.finalize()
    expect(postChunk).toHaveBeenCalledTimes(1)
  })
})
