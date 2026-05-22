/**
 * Output sinks — pluggable destination for a finalized recording's mp3 + VTT.
 *
 * Two implementations:
 *   {@link LocalDirSink}  — writes into a local directory (self-host default).
 *   {@link SpacesSink}    — uploads to DO Spaces (CFG-hosted; selected when
 *                           `DO_SPACES_*` env is present).
 *
 * The post-processor calls `putRecording()` and doesn't care which sink it
 * holds.
 */

import { createReadStream } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { S3Client } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import type { SpacesConfig } from '../config.js'
import type { Logger } from '../logger.js'

export interface RecordingMeta {
  guildId: string
  voiceChannelId: string
  durationMs: number
  speakerCount: number
  transcription: boolean
}

export interface PutRecordingResult {
  /** Location the mp3 was stored at — a filesystem path or an object key. */
  mp3Location: string
  /** Location the VTT was stored at, when one was supplied. */
  vttLocation?: string
}

export interface OutputSink {
  /**
   * Persist a finalized recording. `mp3Path` / `vttPath` are absolute paths
   * to files in the container's temp dir; the sink copies/uploads them and
   * returns the durable locations.
   */
  putRecording(
    recordingId: string,
    mp3Path: string,
    vttPath: string | undefined,
    meta: RecordingMeta,
  ): Promise<PutRecordingResult>
}

/**
 * Local-directory sink (Phase 1). Copies the mp3 (and VTT) into
 * `<outputDir>/<recordingId>/` so a self-host operator can grab them
 * straight off disk.
 */
export class LocalDirSink implements OutputSink {
  constructor(
    private readonly outputDir: string,
    private readonly logger: Logger,
  ) {}

  async putRecording(
    recordingId: string,
    mp3Path: string,
    vttPath: string | undefined,
    _meta: RecordingMeta,
  ): Promise<PutRecordingResult> {
    const dir = join(this.outputDir, recordingId)
    await mkdir(dir, { recursive: true })

    const mp3Dest = join(dir, `${recordingId}.mp3`)
    await copyFile(mp3Path, mp3Dest)

    let vttLocation: string | undefined
    if (vttPath) {
      const vttDest = join(dir, `${recordingId}.vtt`)
      await copyFile(vttPath, vttDest)
      vttLocation = vttDest
    }

    this.logger.info(
      { recordingId, mp3: mp3Dest, vtt: vttLocation ?? null, src: basename(mp3Path) },
      'recording stored to local dir',
    )
    return { mp3Location: mp3Dest, vttLocation }
  }
}

/**
 * DO Spaces sink — CFG-hosted upload destination.
 *
 * Ported from cfg-core-server's `services/recording/post-processor.ts`
 * upload block: same `@aws-sdk/lib-storage` `Upload` flow, same private ACL,
 * same `recordings/<id>/<id>.{mp3,vtt}` key layout. Selected by the session
 * controller when `DO_SPACES_*` env is present.
 *
 * The S3 client is constructed once per sink and reused across recordings.
 */
export class SpacesSink implements OutputSink {
  private readonly s3: S3Client
  private readonly bucket: string

  constructor(
    spaces: SpacesConfig,
    private readonly logger: Logger,
  ) {
    this.bucket = spaces.bucket
    this.s3 = new S3Client({
      region: spaces.region,
      endpoint: spaces.endpoint,
      // Spaces, like most S3-compatible stores, expects path/virtual-host
      // addressing that the default config already handles; credentials are
      // passed explicitly so the container needs no AWS env/profile.
      credentials: { accessKeyId: spaces.key, secretAccessKey: spaces.secret },
    })
  }

  async putRecording(
    recordingId: string,
    mp3Path: string,
    vttPath: string | undefined,
    _meta: RecordingMeta,
  ): Promise<PutRecordingResult> {
    const baseKey = `recordings/${recordingId}/${recordingId}`

    const mp3Key = `${baseKey}.mp3`
    await new Upload({
      client: this.s3,
      params: {
        Bucket: this.bucket,
        Key: mp3Key,
        Body: createReadStream(mp3Path),
        ContentType: 'audio/mpeg',
        ACL: 'private',
      },
    }).done()

    let vttLocation: string | undefined
    if (vttPath) {
      const vttKey = `${baseKey}.vtt`
      await new Upload({
        client: this.s3,
        params: {
          Bucket: this.bucket,
          Key: vttKey,
          Body: createReadStream(vttPath),
          ContentType: 'text/vtt',
          ACL: 'private',
        },
      }).done()
      vttLocation = vttKey
    }

    this.logger.info(
      { recordingId, bucket: this.bucket, mp3: mp3Key, vtt: vttLocation ?? null },
      'recording uploaded to DO Spaces',
    )
    return { mp3Location: mp3Key, vttLocation }
  }
}
