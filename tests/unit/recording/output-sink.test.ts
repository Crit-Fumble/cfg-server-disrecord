/**
 * LocalDirSink + SpacesSink (CFG-hosted DO Spaces upload).
 *
 * The SpacesSink tests mock `@aws-sdk/lib-storage`'s `Upload` so no real
 * network call is made — we only assert the sink wires the right
 * Bucket/Key/ContentType/ACL params and returns the object keys.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const uploadDone = jest.fn(async () => undefined)
const uploadCtor = jest.fn()
jest.mock('@aws-sdk/lib-storage', () => ({
  Upload: jest.fn().mockImplementation((args: unknown) => {
    uploadCtor(args)
    return { done: uploadDone }
  }),
}))
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ __s3: true })),
}))

import { LocalDirSink, SpacesSink, type RecordingMeta } from '../../../src/recording/output-sink.js'
import type { SpacesConfig } from '../../../src/config.js'
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
  const SPACES: SpacesConfig = {
    key: 'k',
    secret: 's',
    bucket: 'cfg-recordings',
    region: 'us-east-1',
    endpoint: 'https://nyc3.digitaloceanspaces.com',
  }
  let srcDir: string

  beforeEach(async () => {
    uploadDone.mockClear()
    uploadCtor.mockClear()
    srcDir = await mkdtemp(join(tmpdir(), 'spaces-src-'))
  })

  afterEach(async () => {
    await rm(srcDir, { recursive: true, force: true })
  })

  it('uploads the mp3 to recordings/<id>/<id>.mp3 with a private ACL', async () => {
    const mp3 = join(srcDir, 'mixed.mp3')
    await writeFile(mp3, 'mp3-bytes')

    const sink = new SpacesSink(SPACES, logger)
    const res = await sink.putRecording('rec-9', mp3, undefined, {} as RecordingMeta)

    expect(res.mp3Location).toBe('recordings/rec-9/rec-9.mp3')
    expect(res.vttLocation).toBeUndefined()
    expect(uploadDone).toHaveBeenCalledTimes(1)
    expect(uploadCtor).toHaveBeenCalledTimes(1)
    const params = uploadCtor.mock.calls[0][0].params
    expect(params).toMatchObject({
      Bucket: 'cfg-recordings',
      Key: 'recordings/rec-9/rec-9.mp3',
      ContentType: 'audio/mpeg',
      ACL: 'private',
    })
  })

  it('uploads the VTT alongside the mp3 when one is supplied', async () => {
    const mp3 = join(srcDir, 'mixed.mp3')
    const vtt = join(srcDir, 'captions.vtt')
    await writeFile(mp3, 'mp3')
    await writeFile(vtt, 'WEBVTT')

    const sink = new SpacesSink(SPACES, logger)
    const res = await sink.putRecording('rec-vtt', mp3, vtt, {} as RecordingMeta)

    expect(res.vttLocation).toBe('recordings/rec-vtt/rec-vtt.vtt')
    expect(uploadDone).toHaveBeenCalledTimes(2)
    const vttParams = uploadCtor.mock.calls[1][0].params
    expect(vttParams).toMatchObject({
      Key: 'recordings/rec-vtt/rec-vtt.vtt',
      ContentType: 'text/vtt',
      ACL: 'private',
    })
  })
})
