/**
 * ConsentSync — seeds the consent manager from a session policy and applies
 * pushed updates. Idempotency is delegated to ConsentManager.apply*.
 */
import { ConsentSync } from '../../../src/phone-home/consent-sync.js'
import { logger } from '../../../src/logger.js'

interface FakeConsent {
  applyConsent: jest.Mock
  applyDecline: jest.Mock
}

function fakeConsent(): FakeConsent {
  return { applyConsent: jest.fn(), applyDecline: jest.fn() }
}

function fakeCore(consentedUserIds: string[]): { fetchSessionPolicy: jest.Mock } {
  return {
    fetchSessionPolicy: jest.fn(async () => ({ consentedUserIds, speakerNames: {} })),
  }
}

describe('ConsentSync', () => {
  it('seeds each pre-consented user from the session policy', async () => {
    const consent = fakeConsent()
    const core = fakeCore(['u1', 'u2'])
    const sync = new ConsentSync({
      consent: consent as never,
      core: core as never,
      logger,
    })
    await sync.seedFromPolicy()
    expect(consent.applyConsent).toHaveBeenCalledWith('u1')
    expect(consent.applyConsent).toHaveBeenCalledWith('u2')
    expect(consent.applyConsent).toHaveBeenCalledTimes(2)
  })

  it('applies a pushed consent=true update via applyConsent', () => {
    const consent = fakeConsent()
    const sync = new ConsentSync({
      consent: consent as never,
      core: fakeCore([]) as never,
      logger,
    })
    sync.applyPushedUpdate('u3', true)
    expect(consent.applyConsent).toHaveBeenCalledWith('u3')
    expect(consent.applyDecline).not.toHaveBeenCalled()
  })

  it('applies a pushed consent=false update via applyDecline', () => {
    const consent = fakeConsent()
    const sync = new ConsentSync({
      consent: consent as never,
      core: fakeCore([]) as never,
      logger,
    })
    sync.applyPushedUpdate('u4', false)
    expect(consent.applyDecline).toHaveBeenCalledWith('u4')
    expect(consent.applyConsent).not.toHaveBeenCalled()
  })
})
