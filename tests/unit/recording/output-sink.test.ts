/**
 * LocalDirSink (Phase 1) + SpacesSink (Phase 2 stub).
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalDirSink, SpacesSink, type RecordingMeta } from '../../../src/recording/output-sink.js'
import { logger } from '../../../src/logger.js'

const META: RecordingMeta = {
  guildId: 'g1',
  voiceChannelId: 'vc1',
  durationMs: 60_000,
  speakerCount: 2,
  transcription: true,
}

describe('LocalDirSink', () => {
  let workDir: string
  let srcDir: string

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'sink-out-'))
    srcDir = await mkdtemp(join(tmpdir(), 'sink-src-'))
  })

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true })
    await rm(srcDir, { recursive: true, force: true })
  })

  it('copies the mp3 into <outputDir>/<recordingId>/', async () => {
    const mp3 = join(srcDir, 'mixed.mp3')
    await writeFile(mp3, 'fake-mp3-bytes')

    const sink = new LocalDirSink(workDir, logger)
    const res = await sink.putRecording('rec-123', mp3, undefined, META)

    expect(res.mp3Location).toBe(join(workDir, 'rec-123', 'rec-123.mp3'))
    expect(res.vttLocation).toBeUndefined()
    expect((await readFile(res.mp3Location)).toString()).toBe('fake-mp3-bytes')
  })

  it('copies the VTT alongside the mp3 when one is supplied', async () => {
    const mp3 = join(srcDir, 'mixed.mp3')
    const vtt = join(srcDir, 'captions.vtt')
    await writeFile(mp3, 'mp3')
    await writeFile(vtt, 'WEBVTT')

    const sink = new LocalDirSink(workDir, logger)
    const res = await sink.putRecording('rec-vtt', mp3, vtt, META)

    expect(res.vttLocation).toBe(join(workDir, 'rec-vtt', 'rec-vtt.vtt'))
    expect((await readFile(res.vttLocation!)).toString()).toBe('WEBVTT')
  })

  it('creates the output directory when it does not exist yet', async () => {
    const nested = join(workDir, 'does', 'not', 'exist')
    const mp3 = join(srcDir, 'm.mp3')
    await writeFile(mp3, 'x')
    const sink = new LocalDirSink(nested, logger)
    const res = await sink.putRecording('r', mp3, undefined, META)
    expect((await readFile(res.mp3Location)).toString()).toBe('x')
  })
})

describe('SpacesSink', () => {
  it('throws — not implemented until Phase 2', async () => {
    await mkdir(tmpdir(), { recursive: true })
    const sink = new SpacesSink()
    await expect(sink.putRecording()).rejects.toThrow(/Phase 2/)
  })
})
