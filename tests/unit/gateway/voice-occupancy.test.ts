import { humanMemberIds } from '../../../src/gateway/voice-capture.js'

const human = (id: string): [string, { user?: { bot?: boolean } }] => [id, { user: { bot: false } }]
const bot = (id: string): [string, { user?: { bot?: boolean } }] => [id, { user: { bot: true } }]

describe('humanMemberIds — the occupancy rule behind "end when empty"', () => {
  it('counts humans and drops every bot, including ours', () => {
    expect(humanMemberIds([human('u1'), bot('bot-self'), human('u2'), bot('music-bot')])).toEqual(['u1', 'u2'])
  })

  it('an all-bot channel is empty — a parked music bot must not keep a recording alive', () => {
    expect(humanMemberIds([bot('bot-self'), bot('music-bot')])).toEqual([])
  })

  it('treats a member with no user payload as human (never guess "bot" from missing data)', () => {
    // A partial member from the gateway cache lacks `user`; assuming it is a
    // bot would start the empty clock on a channel that has someone in it.
    expect(humanMemberIds([['u1', {}], ['u2', null], ['u3', undefined]])).toEqual(['u1', 'u2', 'u3'])
  })

  it('accepts a Map (what discord.js Collection is)', () => {
    const members = new Map<string, { user?: { bot?: boolean } }>([human('a'), bot('b')])
    expect(humanMemberIds(members)).toEqual(['a'])
  })
})
