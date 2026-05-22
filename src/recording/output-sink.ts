/**
 * Output sinks — pluggable destination for a finalized recording's mp3 + VTT.
 *
 * Phase 1 ships {@link LocalDirSink} (writes into a local directory). Phase 2
 * fills in {@link SpacesSink} (DO Spaces upload via @aws-sdk/lib-storage).
 * The post-processor calls `putRecording()` and doesn't care which sink it
 * holds — the standalone container picks LocalDirSink; the CFG-hosted path
 * (Phase 2) picks SpacesSink when `DO_SPACES_*` env is present.
 */

import { copyFile, mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
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
 * DO Spaces sink — Phase 2. Stub for now; throws so a misconfigured Phase 1
 * deployment fails loudly instead of silently dropping recordings.
 */
export class SpacesSink implements OutputSink {
  async putRecording(): Promise<PutRecordingResult> {
    throw new Error('SpacesSink is not implemented until Phase 2 — use LocalDirSink')
  }
}
