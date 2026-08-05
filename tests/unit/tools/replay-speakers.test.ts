/**
 * The tuning harness's clock loop (#12).
 *
 * This is the piece that makes the harness measure the RIGHT knob: it replays
 * each speaker's start/end boundaries so the session's forced-Finalize timer
 * fires as it does in production, instead of only exercising Deepgram's
 * endpointing. If the loop drops a speaker-end or mis-places a boundary, every
 * number the sweep reports is quietly against the wrong timeline — so it is
 * driven here through a fake sink, with no Deepgram socket involved.
 */

import { replaySpeakers, type Speaker, type SpeakerEventSink } from '../../../tools/deepgram-tuning/replay.js'
import { detectSpeechRegions, secToBytes } from '../../../src/recording/pcm-speech-regions.js'
import { PCM_BYTES_PER_MS } from '../../../src/recording/pcm-silence-pad.js'

type Event = { type: 'start' | 'end' | 'data'; userId: string; bytes?: number }

function recorder(): SpeakerEventSink & { events: Event[]; turns: string[] } {
  const events: Event[] = []
  return {
    events,
    /** start/end only — the shape a turn-taking assertion cares about. */
    get turns() {
      return events.filter((e) => e.type !== 'data').map((e) => `${e.type}:${e.userId}`)
    },
    onSpeakerStart: (userId) => void events.push({ type: 'start', userId }),
    onSpeakerEnd: (userId) => void events.push({ type: 'end', userId }),
    onSpeakerData: (userId, frame) => void events.push({ type: 'data', userId, bytes: frame.length }),
  }
}

function silence(ms: number): Buffer {
  return Buffer.alloc(ms * PCM_BYTES_PER_MS)
}

function tone(ms: number): Buffer {
  const buf = Buffer.alloc(ms * PCM_BYTES_PER_MS)
  for (let i = 0; i + 1 < buf.length; i += 2) buf.writeInt16LE(i % 4 === 0 ? 8000 : -8000, i)
  return buf
}

function speaker(userId: string, pcm: Buffer): Speaker {
  return { userId, pcm, regions: detectSpeechRegions(pcm) }
}

describe('replaySpeakers', () => {
  it('opens and closes a turn around each speaking region', async () => {
    const sink = recorder()
    const pcm = Buffer.concat([silence(200), tone(300), silence(2000), tone(300), silence(500)])
    await replaySpeakers([speaker('u-1', pcm)], sink, { realtime: false })

    expect(sink.turns).toEqual(['start:u-1', 'end:u-1', 'start:u-1', 'end:u-1'])
  })

  it('sends audio only while the speaker is talking', async () => {
    const sink = recorder()
    const pcm = Buffer.concat([silence(1000), tone(200), silence(1000)])
    await replaySpeakers([speaker('u-1', pcm)], sink, { realtime: false })

    const audioBytes = sink.events
      .filter((e) => e.type === 'data')
      .reduce((n, e) => n + (e.bytes ?? 0), 0)
    // Only the 200ms burst goes on the wire — exactly like Discord, which
    // delivers no frames during silence. That absence is the whole reason our
    // forced Finalize exists.
    expect(audioBytes).toBe(secToBytes(0.2))
  })

  it('never emits audio past the end of a region', async () => {
    // The final frame of a burst is clamped to the region edge, or the harness
    // feeds padding into Deepgram and shifts the measured boundary.
    //
    // 250ms is deliberately NOT a multiple of the 20ms frame, so detection
    // rounds the region up to the frame holding the last audio. Real Discord
    // audio always arrives as whole 20ms opus frames and never lands here, but
    // the clamp must hold regardless — so this asserts against the DETECTED
    // region rather than the nominal burst length.
    const sink = recorder()
    const pcm = Buffer.concat([tone(250), silence(2000)])
    const s = speaker('u-1', pcm)
    await replaySpeakers([s], sink, { realtime: false })

    const audioBytes = sink.events
      .filter((e) => e.type === 'data')
      .reduce((n, e) => n + (e.bytes ?? 0), 0)
    const regionBytes = s.regions[0].endByte - s.regions[0].startByte
    expect(audioBytes).toBe(regionBytes)
    // ...and the region itself is within one frame of the true burst.
    expect(regionBytes - secToBytes(0.25)).toBeLessThanOrEqual(secToBytes(0.02))
  })

  it('sends a frame-aligned burst byte-for-byte', async () => {
    // The shape a real corpus always has: Discord delivers whole 20ms frames,
    // so region edges land exactly on the audio.
    const sink = recorder()
    const pcm = Buffer.concat([tone(240), silence(2000)])
    await replaySpeakers([speaker('u-1', pcm)], sink, { realtime: false })

    const audioBytes = sink.events
      .filter((e) => e.type === 'data')
      .reduce((n, e) => n + (e.bytes ?? 0), 0)
    expect(audioBytes).toBe(secToBytes(0.24))
  })

  it('interleaves speakers on one shared timeline', async () => {
    // The session fires a pending finalize early when ANOTHER speaker takes
    // the floor, so relative ordering across speakers has to be preserved.
    const sink = recorder()
    const first = Buffer.concat([tone(300), silence(3000)])
    const second = Buffer.concat([silence(1500), tone(300), silence(1200)])
    await replaySpeakers([speaker('u-1', first), speaker('u-2', second)], sink, { realtime: false })

    expect(sink.turns).toEqual(['start:u-1', 'end:u-1', 'start:u-2', 'end:u-2'])
  })

  it('closes a turn left open when the sample runs out', async () => {
    const sink = recorder()
    const pcm = Buffer.concat([silence(200), tone(500)])
    await replaySpeakers([speaker('u-1', pcm)], sink, { realtime: false })

    expect(sink.turns).toEqual(['start:u-1', 'end:u-1'])
  })

  it('emits nothing for a speaker who never spoke', async () => {
    const sink = recorder()
    await replaySpeakers([speaker('u-quiet', silence(3000))], sink, { realtime: false })

    expect(sink.events).toEqual([])
  })

  it('paces to the wall clock when realtime is on', async () => {
    const sink = recorder()
    const pcm = Buffer.concat([tone(200), silence(400)])
    const startedAt = Date.now()
    await replaySpeakers([speaker('u-1', pcm)], sink, { realtime: true })

    // ~600ms of audio must take ~600ms to replay. Compressing the gaps would
    // change the endpointing behaviour the sweep is measuring.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(450)
  })
})
