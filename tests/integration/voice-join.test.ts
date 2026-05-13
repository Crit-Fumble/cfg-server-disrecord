/**
 * Integration test — worker joins the Dev Den test voice channel.
 *
 * Verifies the gateway-bridge adapter wires correctly:
 *   1. Gateway captures VOICE_STATE_UPDATE + VOICE_SERVER_UPDATE on bot's
 *      channel join
 *   2. Hands off tokens to a worker process
 *   3. Worker's @discordjs/voice voice connection reaches Ready state
 *
 * Skipped unless DISRECORD_INTEGRATION_TESTS_ENABLED=true.
 */

import { describeIntegration, getIntegrationEnv } from './_helpers/setup.js'

describeIntegration('worker joins voice channel via gateway-bridge', () => {
  it('reaches VoiceConnectionStatus.Ready (placeholder)', async () => {
    const env = getIntegrationEnv()
    // TODO: full flow. Suite stub — fill in once the gateway HTTP API
    // for spawn-worker exists and the worker's gateway-bridge adapter
    // has the real SSE + POST transport (currently logged-warn stubs).
    expect(env.channelId).toBeTruthy()
  })
})
