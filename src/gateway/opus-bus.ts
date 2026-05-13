/**
 * OpusBus — in-process pub/sub between voice-manager (publisher) and the
 * /internal/sessions/:installationId/audio SSE handler (subscriber).
 *
 * One channel per active session, keyed on installationId. Workers
 * subscribe at session start and receive opus frames + speaker
 * start/end signals until the channel is closed at session end.
 *
 * Memory pattern: backpressure is minimal — the SSE writer is faster than
 * the voice receiver's emit rate (Discord voice ticks at 50 fps per
 * speaker, ~960 bytes/frame). A slow consumer would still grow the
 * Node-side write queue; we bound it implicitly by dropping subscribers
 * after a buffer ceiling (TODO if it becomes a real concern in Phase A).
 */

import { EventEmitter } from 'node:events'

export type AudioChannelEvent =
  | { kind: 'speaker-start'; speakerId: string }
  | { kind: 'speaker-data'; speakerId: string; opus: Buffer }
  | { kind: 'speaker-end'; speakerId: string }
  | { kind: 'session-end'; reason: string }

export interface AudioChannel {
  /** Subscribe to events. Returns an unsubscribe function. */
  subscribe(handler: (event: AudioChannelEvent) => void): () => void
  /** Publish — called by the voice-manager only. */
  publish(event: AudioChannelEvent): void
  /** Close the channel; subsequent publishes are no-ops; subscribers receive a final session-end. */
  close(reason: string): void
  readonly installationId: string
  readonly closed: boolean
}

class AudioChannelImpl implements AudioChannel {
  private emitter = new EventEmitter()
  private _closed = false

  constructor(public readonly installationId: string) {
    // Bump default limit — short-lived channels can hold ~10 subscribers
    // in transition. Default 10 trips DeprecationWarning in tight tests.
    this.emitter.setMaxListeners(64)
  }

  subscribe(handler: (event: AudioChannelEvent) => void): () => void {
    this.emitter.on('event', handler)
    return () => this.emitter.off('event', handler)
  }

  publish(event: AudioChannelEvent): void {
    if (this._closed) return
    this.emitter.emit('event', event)
  }

  close(reason: string): void {
    if (this._closed) return
    this._closed = true
    this.emitter.emit('event', { kind: 'session-end', reason })
    this.emitter.removeAllListeners('event')
  }

  get closed(): boolean {
    return this._closed
  }
}

export class OpusBus {
  private channels = new Map<string, AudioChannelImpl>()

  /** Open or fetch the channel for an installation. Idempotent. */
  open(installationId: string): AudioChannel {
    const existing = this.channels.get(installationId)
    if (existing && !existing.closed) return existing
    const ch = new AudioChannelImpl(installationId)
    this.channels.set(installationId, ch)
    return ch
  }

  /** Get an existing channel (returns null if none open). */
  get(installationId: string): AudioChannel | null {
    const ch = this.channels.get(installationId)
    return ch && !ch.closed ? ch : null
  }

  /** Close the channel and forget it. */
  close(installationId: string, reason: string): void {
    const ch = this.channels.get(installationId)
    if (!ch) return
    ch.close(reason)
    this.channels.delete(installationId)
  }

  /** Test-only: clear all channels. */
  __clearForTests(): void {
    for (const ch of this.channels.values()) ch.close('test-reset')
    this.channels.clear()
  }
}
