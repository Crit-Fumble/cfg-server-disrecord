/**
 * GatewayBridge — cross-process voice-event transport for the worker.
 *
 * The worker doesn't hold a Discord gateway connection (the always-on
 * gateway-router container does). Instead, the worker bridges through that
 * gateway:
 *   - Outbound: when @discordjs/voice's adapter needs to send a voice
 *     state update (mute/deafen/channel change), POST it to gateway's
 *     /internal/voice/send-payload endpoint, which forwards to Discord.
 *   - Inbound: subscribe to the gateway's /internal/voice/events/:guildId
 *     SSE stream and dispatch VOICE_SERVER_UPDATE / VOICE_STATE_UPDATE
 *     events to the @discordjs/voice library callbacks.
 *
 * v0.1 implementation TODO — the interface and adapter wiring are in place,
 * the actual HTTP/SSE transport is the next step. End-to-end tested by
 * spinning the gateway + worker against a real Discord channel.
 */

import type {
  DiscordGatewayAdapterCreator,
  DiscordGatewayAdapterLibraryMethods,
  DiscordGatewayAdapterImplementerMethods,
} from '@discordjs/voice'
import type { Logger } from '../logger.js'

export interface GatewayBridgeParams {
  /** Gateway base URL (resolved from WorkerConfig.coreServerUrl + path? or env). */
  gatewayUrl: string
  /** Shared secret for HTTP auth between worker ↔ gateway. */
  authSecret: string
  guildId: string
  /** Seed voice tokens captured by gateway at session-start. */
  seedVoiceServerUpdate: {
    guild_id: string
    token: string
    endpoint: string | null
  }
  seedVoiceStateUpdate: {
    guild_id: string
    channel_id: string | null
    user_id: string
    session_id: string
    deaf: boolean
    mute: boolean
    self_deaf: boolean
    self_mute: boolean
    self_video: boolean
    suppress: boolean
    request_to_speak_timestamp: string | null
  }
  logger?: Logger
}

/**
 * Build a DiscordGatewayAdapterCreator wired to the gateway-router. Pass the
 * returned creator to @discordjs/voice's `joinVoiceChannel`.
 *
 * The library calls the creator with its LibraryMethods callbacks; we hand
 * back ImplementerMethods that POST to the gateway. We also seed the library
 * with the initial VOICE_SERVER_UPDATE / VOICE_STATE_UPDATE captured by the
 * gateway before this worker was spawned — without those, the voice WSS
 * never establishes (Discord requires the token+session_id+endpoint triple).
 */
export function createGatewayBridgeAdapterCreator(
  params: GatewayBridgeParams,
): DiscordGatewayAdapterCreator {
  const { logger } = params
  return (methods: DiscordGatewayAdapterLibraryMethods): DiscordGatewayAdapterImplementerMethods => {
    // Seed the library with the handoff tokens — must happen BEFORE we open
    // the SSE subscription so the voice connection has what it needs from
    // its first internal tick.
    methods.onVoiceServerUpdate(params.seedVoiceServerUpdate)
    methods.onVoiceStateUpdate(params.seedVoiceStateUpdate)

    // TODO: open SSE subscription to /internal/voice/events/:guildId and
    // forward subsequent events into methods.onVoice*Update.
    logger?.warn('GatewayBridge SSE subscription not yet implemented')

    let destroyed = false
    return {
      destroy: () => {
        if (destroyed) return
        destroyed = true
        logger?.info('GatewayBridge adapter destroyed')
        // TODO: close SSE subscription
      },
      sendPayload: (_payload: unknown): boolean => {
        if (destroyed) return false
        // TODO: POST _payload to ${gatewayUrl}/internal/voice/send-payload
        // with `${authSecret}` bearer header. Returns true on accept.
        logger?.warn({ payloadKeys: typeof _payload === 'object' && _payload != null ? Object.keys(_payload as object) : [] }, 'GatewayBridge sendPayload not yet implemented')
        return true
      },
    }
  }
}
