/**
 * Recover a speaker's speaking intervals from their raw PCM file.
 *
 * Needed by the Deepgram tuning harness (#12). Replaying a per-speaker PCM
 * file into Deepgram exercises only Deepgram's own `endpointing` — but that is
 * NOT the dominant segment-length control in production. Discord's receiver
 * only emits frames while someone is actually speaking, so when a speaker
 * stops there is no trailing silence on the socket for Deepgram to endpoint
 * on; the forced `Finalize` scheduled by `RecordingSession.onSpeakerEnd` is
 * what actually closes the segment. A harness that just streams the file
 * measures the knob that matters least.
 *
 * So the harness has to replay speaking start/end boundaries alongside the
 * audio — and those are recoverable from the file itself, with no extra
 * metadata. `padSilenceAndAppend` inserts *synthesized* silence (literal
 * zero bytes) to keep each speaker's byte offset on the shared wall clock, so
 * the non-silent regions of the file ARE the intervals during which Discord
 * was delivering frames.
 *
 * Pure: no I/O, no clock. Operates on a whole buffer and returns byte ranges,
 * which convert to wall-clock seconds via {@link PCM_BYTES_PER_MS} because
 * byte position tracks wall clock by construction.
 */

import { PCM_BYTES_PER_MS } from './pcm-silence-pad.js'

/**
 * Classification granularity. 20 ms matches the Discord/Opus frame size, so
 * region edges land where real frame boundaries were.
 */
export const PCM_FRAME_MS = 20

/**
 * Silence shorter than this is bridged rather than treated as the speaker
 * stopping. This is the knob that maps gaps in the file back to Discord
 * `speaking end` events: Discord stops delivering packets a few hundred ms
 * after someone actually goes quiet, and an opus decode can contain brief runs
 * of digital silence *inside* a burst that are not a speaker-end at all.
 *
 * Must stay well BELOW the `utteranceEndMs` values under test — otherwise the
 * harness invents different turn boundaries than production saw, and every
 * measurement downstream is against the wrong timeline.
 */
export const DEFAULT_MIN_SILENCE_MS = 300

/** Regions shorter than this are dropped as decode specks, not utterances. */
export const DEFAULT_MIN_SPEECH_MS = 100

/** One interval during which this speaker was delivering audio. */
export interface SpeechRegion {
  /** Inclusive byte offset into the speaker's PCM. */
  startByte: number
  /** Exclusive byte offset into the speaker's PCM. */
  endByte: number
}

export interface DetectSpeechRegionsOptions {
  frameMs?: number
  minSilenceMs?: number
  minSpeechMs?: number
  /**
   * Max absolute sample value still counted as silence. Defaults to 0 because
   * the padding this detector is separating out is `Buffer.alloc` — exact
   * zeroes — so an exact test is both correct and unambiguous. Raise it only
   * for audio that has been through a lossy round-trip.
   */
  silenceThreshold?: number
}

/** Seconds of audio represented by `bytes` of 48 kHz mono s16le PCM. */
export function bytesToSec(bytes: number): number {
  return bytes / PCM_BYTES_PER_MS / 1000
}

/** Byte offset at `sec` seconds, rounded down to a whole sample. */
export function secToBytes(sec: number): number {
  const bytes = Math.floor(sec * 1000 * PCM_BYTES_PER_MS)
  return bytes % 2 === 0 ? bytes : bytes - 1
}

/** True when every sample in `[start, end)` is at or below `threshold`. */
function isFrameSilent(pcm: Buffer, start: number, end: number, threshold: number): boolean {
  for (let i = start; i + 1 < end; i += 2) {
    if (Math.abs(pcm.readInt16LE(i)) > threshold) return false
  }
  return true
}

/**
 * Split `pcm` into the intervals where the speaker was actually talking.
 *
 * A region closes at the START of the silence run that ended it (not where
 * the run was detected), so region boundaries line up with the moment audio
 * stopped — which is what `onSpeakerEnd` fires on in production.
 */
export function detectSpeechRegions(
  pcm: Buffer,
  options: DetectSpeechRegionsOptions = {},
): SpeechRegion[] {
  const frameMs = options.frameMs ?? PCM_FRAME_MS
  const frameBytes = frameMs * PCM_BYTES_PER_MS
  const minSilenceBytes = (options.minSilenceMs ?? DEFAULT_MIN_SILENCE_MS) * PCM_BYTES_PER_MS
  const minSpeechBytes = (options.minSpeechMs ?? DEFAULT_MIN_SPEECH_MS) * PCM_BYTES_PER_MS
  const threshold = options.silenceThreshold ?? 0

  const regions: SpeechRegion[] = []
  let regionStart = -1
  let silenceRunStart = -1

  for (let offset = 0; offset < pcm.length; offset += frameBytes) {
    const frameEnd = Math.min(offset + frameBytes, pcm.length)
    if (!isFrameSilent(pcm, offset, frameEnd, threshold)) {
      if (regionStart < 0) regionStart = offset
      silenceRunStart = -1
      continue
    }
    // Leading silence, before this speaker has said anything.
    if (regionStart < 0) continue
    if (silenceRunStart < 0) silenceRunStart = offset
    if (frameEnd - silenceRunStart >= minSilenceBytes) {
      regions.push({ startByte: regionStart, endByte: silenceRunStart })
      regionStart = -1
      silenceRunStart = -1
    }
  }

  // A speaker still talking when the file ends — the recording stopped
  // mid-utterance, which is exactly what `session.stop()`'s drain handles.
  if (regionStart >= 0) {
    regions.push({ startByte: regionStart, endByte: pcm.length })
  }

  return regions.filter((r) => r.endByte - r.startByte >= minSpeechBytes)
}
