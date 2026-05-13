# cfg-server-disrecord integration tests

Integration tests exercise real Discord + Deepgram against the
**Dev Den** guild (Discord ID `1153767296867770378`).

## Setup

1. Confirm the cfg-server-disrecord Discord application (client_id `1504164101553656028`)
   is invited to the Dev Den guild with the `bot` + `applications.commands`
   scopes and the following intents enabled:
   - Guild Voice States
   - Guild Members
   - Message Content
2. Create a voice channel in Dev Den named `cfg-server-disrecord-test` for the suite
   to join.
3. Export env vars before running:
   ```sh
   export DISRECORD_INTEGRATION_TESTS_ENABLED=true
   export DISRECORD_DISCORD_TOKEN=...           # bot token for client_id 1504164101553656028
   export DEEPGRAM_API_KEY=...                # platform Deepgram key
   export CORE_SERVER_URL=http://localhost:3001
   export DISRECORD_GATEWAY_BEARER=...           # shared bearer for the integration test → gateway control-plane hop
   export DISRECORD_TEST_GUILD_ID=1153767296867770378
   export DISRECORD_TEST_CHANNEL_ID=...          # voice channel id in Dev Den
   ```
4. Start the local cfg-core-server stack (so the worker can POST transcripts).

## Run

```sh
npm run test:integration
```

Tests are serial (`maxWorkers: 1`) and have a 60s timeout each — Discord
gateway connect + voice handshake routinely takes 5-10s.

## What the suite covers

| File | Covers |
|---|---|
| `gateway-boot.test.ts` | Gateway mode boots, Discord client connects to Dev Den, HTTP /health responds |
| `voice-join.test.ts` | Worker joins the test voice channel via gateway-bridge adapter |
| `record-end-to-end.test.ts` | 30-second recording session: gateway spawns worker, worker captures audio, Deepgram transcripts arrive, transcripts POST'd back |
| `consent-gate.test.ts` | Non-consenter speech produces `[redacted]` placeholder |
| `byok-deepgram.test.ts` | BYO Deepgram key route: worker uses user-provided key, no platform billing |

## CI policy

Integration tests do NOT run on every PR — they require real Deepgram credits
and would burn CT against the platform pool. Run manually before each ship.
A nightly GitHub Actions job (TODO) runs them against a dedicated test app.
