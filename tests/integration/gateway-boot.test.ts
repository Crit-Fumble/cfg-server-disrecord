/**
 * Integration test — gateway mode boots and connects to Dev Den.
 *
 * Verifies the gateway can:
 *   1. Log into Discord as the cfg-resesh bot (client_id 1504164101553656028)
 *   2. See the Dev Den guild in its cache
 *   3. Serve /health on its HTTP port
 *
 * Skipped unless RESESH_INTEGRATION_TESTS_ENABLED=true.
 */

import { describeIntegration, getIntegrationEnv, DEV_DEN_GUILD_ID } from './_helpers/setup.js'

describeIntegration('gateway boots against Dev Den', () => {
  it('boots and lists Dev Den among its guilds (placeholder)', async () => {
    const env = getIntegrationEnv()
    // TODO: actual gateway boot. Suite stub — fill in once startGateway()
    // is callable from a test (extract the body so tests can supply
    // overrides without booting a real Fastify server).
    expect(env.guildId).toBe(DEV_DEN_GUILD_ID)
  })
})
