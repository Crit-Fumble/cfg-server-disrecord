/**
 * Cross-repo contract test over the settings-file format.
 *
 * The fixture is committed byte-identical in BOTH repos (see the "//" key
 * inside it), and this file pins the SAME three expectation literals as
 * cfg-core-server/tests/unit/services/disrecord/settings-file-contract.test.ts —
 * so semantic drift between the two parsers fails a build, not just shape
 * drift. THIS repo (settings-store.ts) is the source of truth; core carries a
 * verbatim mirror. If a change here goes red, change BOTH parsers or neither.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CHANNEL_SETTINGS_KEYS,
  effectiveSettings,
  parseSettingsFile,
} from '../../../src/settings/settings-store.js'

const raw = readFileSync(join(__dirname, 'fixtures', 'settings-contract.worlds.json'), 'utf8')

// ⚠️ Pinned in BOTH repos — keep these literals identical to the core copy.
const EXPECTED_WORLDS = {
  '100000000000000001': {
    name: 'Contract Test Guild',
    defaults: {
      keywords: ['Strahd', 'Barovia'],
      transcriptionEnabled: true,
      outputChannelId: '300000000000000003',
      threadNameTemplate: '{{voiceChannel}} - {{date}} - {{kind}}',
    },
    scenes: {
      '200000000000000002': {
        keywords: [],
        deepgramModel: 'nova-3',
        outputThreadId: '400000000000000004',
      },
      '200000000000000009': { keyterms: ['Vistani'], transcriptionEnabled: false },
    },
    grants: [
      {
        scope: 'campaign',
        id: 'contract-campaign-1',
        label: 'Curse of the Contract',
        scenes: ['200000000000000002'],
        members: [{ discordUserId: '500000000000000005', seat: 'gm' }],
      },
    ],
  },
}

describe('settings-file contract fixture', () => {
  it('round-trips the committed fixture exactly (and ignores the "//" pointer key)', () => {
    // toEqual, not toStrictEqual — the parser builds null-prototype objects.
    expect(parseSettingsFile(JSON.parse(raw))).toEqual({ version: 1, worlds: EXPECTED_WORLDS })
  })

  it('resolves scene overrides field-by-field, explicit empty beating the world default', () => {
    const world = parseSettingsFile(JSON.parse(raw)).worlds['100000000000000001']
    // Scene …0002: explicit keywords:[] wins; everything else inherits.
    expect(effectiveSettings(world, '200000000000000002')).toEqual({
      keywords: [],
      transcriptionEnabled: true,
      deepgramModel: 'nova-3',
      outputChannelId: '300000000000000003',
      outputThreadId: '400000000000000004',
      threadNameTemplate: '{{voiceChannel}} - {{date}} - {{kind}}',
    })
    // Scene …0009: keyterms + a false boolean override; keywords inherit.
    expect(effectiveSettings(world, '200000000000000009')).toEqual({
      keywords: ['Strahd', 'Barovia'],
      keyterms: ['Vistani'],
      transcriptionEnabled: false,
      outputChannelId: '300000000000000003',
      threadNameTemplate: '{{voiceChannel}} - {{date}} - {{kind}}',
    })
    // Unknown channel: pure world defaults.
    expect(effectiveSettings(world, '999999999999999999')).toEqual({
      keywords: ['Strahd', 'Barovia'],
      transcriptionEnabled: true,
      outputChannelId: '300000000000000003',
      threadNameTemplate: '{{voiceChannel}} - {{date}} - {{kind}}',
    })
  })

  it('keeps the operational-field allow-list at exactly the 8 mirrored keys', () => {
    expect(CHANNEL_SETTINGS_KEYS).toEqual([
      'keywords',
      'keyterms',
      'transcriptionEnabled',
      'deepgramModel',
      'deepgramLanguage',
      'outputChannelId',
      'outputThreadId',
      'threadNameTemplate',
    ])
  })
})
