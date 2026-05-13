# Handoff — cfg-resesh end-to-end recording, 2026-05-13

Self-contained briefing for the next session to pick up cleanly. Read this
top-to-bottom; everything you need to continue is here or linked.

## The mission

Ship end-to-end Discord voice recording as a user-provisioned **Recording
Server** by Friday 2026-05-15. The Recording Server lives in its own
container (one per active session, one per Discord guild), is provisioned
through the new Server Manager kind-registry in cfg-core-server, and bills
against the user's CT pool. Voice transport is **Option B**: gateway holds
voice + opus decode, worker is an SSE consumer that runs Deepgram and POSTs
transcripts back to core-server.

Plan file (full detail):
`/Users/hobdaytrain/.claude/plans/we-just-refactored-all-rustling-teacup.md`

## Repos + commits (as of 2026-05-13 EOD)

Three repos, all on `main` of their respective worktrees under `workspaces/`.
**Nothing has been pushed to origin yet** — that's a deliberate handoff per
the `feedback_no_default_origin_push` memory.

### cfg-core-server (7 commits ahead of origin/main)

```
f9ce544  feat(routes): core-server endpoints for ReSesh worker callbacks
66345a1  feat(server-manager): real ReSesh adapter — HTTP bridge to gateway
a939bfd  feat(server-manager): ReSesh adapter stub + register in bootstrap
3fb74e2  feat(server-manager): kind-registry interface + FoundryVTT adapter
d8c7ede  config(prod): backfill production.json from OLD monorepo values
3e2bbb7  fix(discord): resolve bot user ID before /guilds/:id/members/:userId
224c077  perf(transcription): keep Deepgram WS open across utterances
```

### cfg-core-browser (1 commit ahead of origin/main)

```
bba2bd1  config(prod): backfill production.json + add ReSesh app icon
```

### cfg-resesh (10 commits, NO REMOTE YET)

```
5507e45  chore(docker): rewrite Dockerfile + add RUNBOOK
af2cf4a  feat(gateway): real gateway core — voice join, worker spawn, audio SSE
280f433  feat(worker): pivot to Option B — SSE consumer + core-server callbacks
13ab580  docs: refine voice-transport constraint with Hob's clarification
9a1ccac  docs: voice transport analysis — Discord protocol constraint + 3 paths
3747cf3  feat(worker): voice-receiver + worker wiring (opus → PCM → RecordingSession)
a106a88  feat(voice): gateway-bridge adapter scaffold + integration test suite
a088320  feat(worker): port RecordingSession from cfg-core-server transcription.ts
e13686e  feat(deepgram): port Deepgram streaming client from cfg-core-server
5eca876  chore(repo): scaffold cfg-resesh — Discord voice recording + transcription server
```

The cfg-resesh repo doesn't have a GitHub remote yet. Whoever picks this up
needs to run `gh repo create Crit-Fumble/cfg-resesh --public --source=. --push`
when ready. Until then, the commits live locally only.

## Architecture decisions locked

- **Option B voice transport**: gateway holds Discord gateway + per-guild
  voice connection + opus decode; workers consume opus over SSE from
  `/internal/sessions/:installationId/audio` and run Deepgram + transcript
  POST + billing tick. See `docs/voice-transport-analysis.md`.
- **No cross-repo Prisma coupling**: session state lives in gateway memory +
  reconciled from Docker container labels on boot (not in a core-server
  table). Phase 1 → Redis. See `docs/gateway-core-infra.md`.
- **One Recording Server per guild at any time**: enforced by gateway
  via 409 Conflict; matches Discord's underlying per-bot-per-guild rule.
- **Bot identity**: client_id `1504164101553656028` (the cfg-resesh Discord
  application). Created by Hob. NOT yet invited to Dev Den.
- **User-facing noun**: "Recording Server" (per Hob, 2026-05-13).
- **Test guild**: Dev Den, guild id `1153767296867770378`.

## Tests

| Repo | Unit suites | Tests |
|---|---|---|
| cfg-core-server | 219 (was 213) | 3273 (was 3237) |
| cfg-resesh | 9 | 99 |
| cfg-resesh integration | 5 stubs | skipped without `RESESH_INTEGRATION_TESTS_ENABLED=true` |

cfg-resesh tests cover: config, Deepgram client (verbatim port + URL builder
+ keepalive cleanup), RecordingSession (consent gate, WS lifecycle, mid-
session flip, transcripts), worker voice-receiver SSE protocol, core-server-
client, gateway session-store, gateway opus-bus, gateway routes with mocked
Discord + worker spawn.

cfg-core-server has new tests for: resesh-auth (constant-time bearer compare),
resesh-routes (transcripts POST + billing tick + session-policy).

## What's working (typecheck + unit-tested, NOT yet exercised against real Discord)

- Server Manager kind-registry with FoundryVTT (zero behavior change) + ReSesh
- ReSesh adapter HTTP wiring to gateway
- Gateway: Discord client, voice channel join, opus subscribe per speaker,
  worker container spawn via dockerode (with read-only root + tmpfs + CPU/mem
  limits per size), SSE audio forwarder, 409 conflict enforcement, graceful
  shutdown, Docker reconciliation of orphan workers on boot
- Worker: SSE opus consumer, opus decode via @discordjs/opus, RecordingSession
  with per-speaker Deepgram, transcript POST, periodic 15-min billing tick
- core-server: `POST /api/v1/recording/transcripts`, `POST /api/v1/billing/uptime-tick`,
  `GET /api/v1/recording/session-policy/:installationId`, all auth'd via
  shared bearer secret

## What's NOT yet done (Friday work)

1. **Run the runbook** at `cfg-resesh/docs/RUNBOOK.md` against the Dev Den.
   This is the verification that everything actually works end-to-end. Hob
   has to do this — needs the Discord token, bot invite, voice channel
   presence.

2. **Push to origin**. None of today's commits are pushed. Per
   `feedback_no_default_origin_push`, the human pushes; agents commit only.

3. **Build + push cfg-resesh container image**. The Dockerfile is correct
   but `docker build` requires a GitHub token with `read:packages` scope.
   Default `gh auth token` typically lacks this — run:
   ```sh
   gh auth refresh -s read:packages
   ```
   Then:
   ```sh
   cd workspaces/cfg-resesh
   DOCKER_BUILDKIT=1 docker build \
     --secret id=npmrc,src=<(echo "//npm.pkg.github.com/:_authToken=$(gh auth token)") \
     -t registry.digitalocean.com/crit-fumble/cfg-resesh:latest .
   docker push registry.digitalocean.com/crit-fumble/cfg-resesh:latest
   ```

4. **Wire cfg-resesh-gateway into the prod deploy workflow**. Production
   docker-compose / deploy-production.yml needs a new service entry for
   the gateway container. Sample shape:
   ```yaml
   cfg-resesh-gateway:
     image: registry.digitalocean.com/crit-fumble/cfg-resesh:latest
     command: gateway
     environment:
       RESESH_DISCORD_TOKEN: ${RESESH_DISCORD_TOKEN}
       RESESH_DISCORD_PUBLIC_KEY: ${RESESH_DISCORD_PUBLIC_KEY}
       CORE_SERVER_URL: http://core-server:3001
       CORE_SERVER_AUTH_SECRET: ${RESESH_AUTH_SECRET}
       PORT: 4400
       DOCKER_SOCKET_PATH: /var/run/docker.sock
       RESESH_WORKER_IMAGE: registry.digitalocean.com/crit-fumble/cfg-resesh:latest
     volumes:
       - /var/run/docker.sock:/var/run/docker.sock  # workers spawned via dockerode
     networks:
       - crit-fumble-network
   ```
   core-server also needs `RESESH_AUTH_SECRET` set in its env so the worker
   callback routes can verify the shared bearer.

5. **Tag releases**: cfg-core-server v1.2.0, cfg-core-browser v1.1.4,
   cfg-resesh v0.1.0.

6. **Integration tests**: 5 suites in `tests/integration/` are scaffolds.
   Fleshing them out would mean: spinning up a real gateway + worker against
   Dev Den, programmatic audio injection (a small helper that joins as a
   regular user and plays a pre-recorded WAV file), assertions against
   captured transcripts. Not on the Friday critical path; nice-to-have
   for confidence.

## Critical files for next session

If you're picking this up, read these in order:

1. `/Users/hobdaytrain/.claude/plans/we-just-refactored-all-rustling-teacup.md`
   — the locked plan (approved Wed PM).
2. `cfg-resesh/docs/RUNBOOK.md` — exact commands to bring up cfg-resesh
   locally and exercise it against Dev Den.
3. `cfg-resesh/docs/gateway-core-infra.md` — architecture map (Phase 0
   topology, hot/warm/cold paths, proxy vs direct pattern).
4. `cfg-resesh/docs/voice-transport-analysis.md` — why Option B (Discord
   protocol constraint analysis).
5. `cfg-resesh/docs/ARCHITECTURE.md` — front-door explainer for the repo.

Key implementation files (cfg-resesh, in order of "where to start"):

- `src/gateway.ts` — gateway entrypoint, wires everything together
- `src/gateway/routes.ts` — POST /v1/sessions handler (real impl)
- `src/gateway/voice-manager.ts` — joinVoiceChannel + opus subscribe
- `src/gateway/worker-spawn.ts` — dockerode container spawn
- `src/worker.ts` — worker entrypoint
- `src/worker/voice-receiver.ts` — SSE consumer
- `src/worker/recording-session.ts` — per-speaker Deepgram orchestration

cfg-core-server worker-callback routes:

- `src/routes/internal/resesh/transcripts.ts`
- `src/routes/internal/resesh/billing.ts`
- `src/routes/internal/resesh/session-policy.ts`
- `src/proxy/resesh-auth.ts` — shared bearer auth

## Memory + behavior conventions to honor in the next session

- **No-failing-test pushes** — husky pre-push runs `npm test`. If a test fails,
  fix the underlying issue. Never `--no-verify`.
- **No default origin push** — agents commit; Hob pushes.
- **No unilateral prod cutover** — every prod-affecting action requires explicit
  go-ahead. Tagging, image pushing, and deploy-production workflow runs are
  all manual.
- **Alpha-phase, no legacy handling** — 9 users; rip and replace freely.
  Don't add backwards-compat shims.
- **Worktrees**: this work is happening directly on `main` in each repo's
  `workspaces/` checkout. NOT in worktree directories.

## Open Phase 0 limitations (filed as follow-ups)

These are NOT blockers for the Friday demo but are worth noting:

- Transcript persistence table — Phase 0 logs + SSE; persistence is a
  follow-up issue when the demo proves stable.
- Speaker-name resolver returns user IDs in Phase 0. The session-policy
  endpoint returns empty `speakerNames: {}`; worker falls back to user ID
  for display. UI follow-up wires real Discord member display name lookup.
- DAVE-encrypted channels: voice connection establishes but opus decode
  fails on every frame. Canary handling is `cfg-core-dev-tools#18`.
- Session state durability: in-memory + Docker reconciliation on gateway
  boot. Phase 1 → Redis.

## How the next session should restart

```
"I'm picking up from the cfg-resesh end-to-end recording handoff.
Read cfg-resesh/docs/HANDOFF.md, then continue from the
'What's NOT yet done (Friday work)' list. I'll drive verification
against Dev Den; you handle commits + tests + helper docs as needed."
```

That'll give the next agent enough context to continue without re-deriving
everything from scratch.
