/**
 * Integration test — consent gate redacts non-consenter speech.
 *
 * Flow:
 *   1. Start a recording session in Dev Den's test channel
 *   2. Two users join voice — one in the consent set, one not
 *   3. Both speak
 *   4. Verify: the consenter's transcript arrives verbatim; the non-
 *      consenter's turn appears as a single `[redacted]` event
 *
 * Skipped unless RESESH_INTEGRATION_TESTS_ENABLED=true.
 */

import { describeIntegration } from './_helpers/setup.js'

describeIntegration('consent gate', () => {
  it('emits [redacted] for non-consenter (placeholder)', async () => {
    // TODO: implement after voice-receiver lands. Reuses the same
    // injection helper from record-end-to-end.test.ts.
    expect(true).toBe(true)
  })
})
