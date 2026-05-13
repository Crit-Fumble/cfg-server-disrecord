/**
 * Integration test — BYO Deepgram key route.
 *
 * Flow:
 *   1. Provision a session with `deepgramMode: 'byok'` + a valid user-provided
 *      Deepgram key
 *   2. Run a short recording
 *   3. Verify: transcripts arrive, BUT no `transcription_minutes` billing
 *      events are emitted against the user's CT pool (only `container_uptime`)
 *
 * Skipped unless RESESH_INTEGRATION_TESTS_ENABLED=true.
 */

import { describeIntegration } from './_helpers/setup.js'

describeIntegration('BYOK Deepgram billing route', () => {
  it('charges only container_uptime, not transcription_minutes (placeholder)', async () => {
    // TODO: implement once billing emission is wired (cfg-core-dev-tools#120).
    expect(true).toBe(true)
  })
})
