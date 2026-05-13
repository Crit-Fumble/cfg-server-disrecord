/**
 * Integration test — end-to-end 30-second recording session.
 *
 * Driver flow:
 *   1. Gateway started, connected to Dev Den
 *   2. POST /v1/sessions to gateway → spawns worker for test channel
 *   3. Speak into the channel (manual or pre-recorded audio injected via
 *      a test helper that joins the channel as a regular user)
 *   4. After 30s, POST DELETE /v1/sessions/:id
 *   5. Verify: transcripts arrived at core-server, billing tick emitted,
 *      worker exited cleanly
 *
 * Skipped unless DISRECORD_INTEGRATION_TESTS_ENABLED=true.
 */

import { describeIntegration } from './_helpers/setup.js'

describeIntegration('end-to-end recording', () => {
  it('records 30 seconds, transcribes, and persists (placeholder)', async () => {
    // TODO: implement once gateway HTTP + worker spawn + voice-receiver
    // are all wired. Largest integration in the suite.
    expect(true).toBe(true)
  })
})
