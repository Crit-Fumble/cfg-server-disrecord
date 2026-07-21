import { classifyOwnRemoval } from '../../../src/gateway/voice-capture.js'

const BOT = 'bot-123'
const OURS = 'chan-ours'
const OTHER = 'chan-other'

const call = (o: Partial<Parameters<typeof classifyOwnRemoval>[0]>) =>
  classifyOwnRemoval({
    botUserId: BOT,
    ourChannelId: OURS,
    subjectId: BOT,
    oldChannelId: OURS,
    newChannelId: null,
    ...o,
  })

describe('classifyOwnRemoval', () => {
  it('flags a user disconnecting the bot from our channel', () => {
    expect(call({})).toBe('disconnected from voice by a user')
  })

  it('flags a user moving the bot to a different channel', () => {
    // A move is just as deliberate as a kick, and the destination is not the
    // channel we were asked to record — so the recording should end.
    expect(call({ newChannelId: OTHER })).toBe(
      `moved to another voice channel by a user (${OTHER})`,
    )
  })

  it('ignores voice-state changes for OTHER users leaving our channel', () => {
    // A human leaving is normal churn — voice-empty handles that, not us.
    expect(call({ subjectId: 'someone-else' })).toBeNull()
  })

  it('ignores the bot JOINING our channel', () => {
    expect(call({ oldChannelId: null, newChannelId: OURS })).toBeNull()
  })

  it('ignores a mute/deafen toggle while still in our channel', () => {
    // Same channel on both sides — Discord fires voiceStateUpdate for mute,
    // deafen, video and stream changes too. None of those are a removal.
    expect(call({ oldChannelId: OURS, newChannelId: OURS })).toBeNull()
  })

  it('ignores churn in a channel we are not recording', () => {
    expect(call({ oldChannelId: OTHER, newChannelId: null })).toBeNull()
  })

  it('is inert when the bot user id is unknown', () => {
    // client.user is null before READY; never guess that an unknown subject
    // is us, or an unrelated leave would kill the recording.
    expect(call({ botUserId: undefined })).toBeNull()
  })
})
