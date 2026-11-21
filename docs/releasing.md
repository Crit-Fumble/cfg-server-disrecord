# Releasing DisRecord

Everything this repo owns to get a build into production.

## The contract

```
PR (version bump rides it) ──▶ next ──fast-forward──▶ main ──tag v*──▶ release.yml
                                                                          │
                                                            ghcr.io/crit-fumble/
                                                        cfg-server-disrecord:<tag>
                                                                          │
                         core-server spawns, by digest, the release ──────┘
                              a host picked in Server Manager (next session)
```

`ghcr.io/crit-fumble/cfg-server-disrecord` is a **public** package, so no pull
secret is involved anywhere.

## Tagging deploys — when a host picks the release, not immediately

Production spawns, by digest, the release each DisRecord server's host picked
in Server Manager. A server with none picked yet takes the newest release (the
one `:latest` names) at its first launch; a recording no server owns runs the
platform's own pinned release.

So **a worker release is: tag → wait for the image**. There is no deploy step
and no host command; a server's next recording session starts on the new build
once its host picks it. A session already running keeps its container until it ends.

## Cutting a release

**1. Bump the version in a PR into `next`.**

The bump has to land *before* promotion. `main` is fast-forward-only (dt#489),
so a version-bump commit created on `main` after promoting would put `main`
ahead of `next` and break the next fast-forward permanently.

```sh
# in a branch off next, as part of the release PR
npm version --no-git-tag-version patch    # or minor / major
```

`--no-git-tag-version` matters: plain `npm version` commits and tags for you,
which is the trap above.

Before promoting, run the recorder launch spec from `cfg-core-dev-tools`
against its local e2e stack (`npm run test:up`). It needs no Discord token:

```sh
cd dev/e2e-tests
node scripts/_disrecord-fixture-image.mjs --rebuild
E2E_DOCKER=true npx playwright test --project=api tests/resesh/recorder-launch-spacebar.api.spec.ts
```

The stack runs `cfg-server-disrecord:test`, which the spec builds from dev-tools'
`workspaces/cfg-server-disrecord` checkout when it is absent or stale. The spec
starts a recording through core-server, and the worker it launches logs in to
the stack's Spacebar instance instead of Discord. It checks the launch from outside: the bot logged in, the worker read
the settings file core-server mounted for it, and the container's user, mounts
and environment are the ones core-server chose. The start then fails at the
voice join, because Spacebar's voice gateway refuses the protocol the recorder
speaks. So the spec proves the launch and nothing after it: capture, mix and
upload are step 5.

**2. Promote `next` → `main`** by fast-forward. Never a merge button — squash,
merge commit and rebase-merge all leave the branches permanently unrelated.

```sh
git fetch origin --prune          # NOT optional: origin/next is a local
                                  # tracking ref; a stale one silently
                                  # promotes an older commit and reports success
git push origin origin/next:main
```

**3. Tag the promoted commit and push it.**

```sh
git fetch origin --prune
git tag "v$(node -p "require('./package.json').version")" origin/main
git push origin --tags
```

**4. Verify the publish actually happened.** ⚠️ Do NOT skip this, and do not
treat a pushed tag as a shipped release.

The `verify` job refuses to publish on each condition in the table below, and
**every one of them fails AFTER the tag is pushed**, in a workflow nobody is
required to watch. A refused publish leaves `:latest` on the
PREVIOUS image while the tag exists and looks successful — so anything
downstream that assumes the new worker is live is now wrong, silently.

```sh
# the run must be SUCCESS, not just present
gh run list --repo Crit-Fumble/cfg-server-disrecord --workflow release.yml --limit 3

# and :latest must actually carry the new version
gh api /orgs/Crit-Fumble/packages/container/cfg-server-disrecord/versions \
  --jq '.[0].metadata.container.tags'
```

Do not `docker pull` on the prod host — a launch pulls the release it runs, by
digest.

**5. Record a minute on Discord by hand.** No automated test touches real
Discord, and prod acceptance never starts a recording, yet a published release
reaches every server whose host picks it. So once `:latest` carries the new
version, the owner makes one: start a recording from Server Manager, on a server
that runs the new release, in a test voice channel, say a few words, and stop it
after about a minute. It passes when the bot joins, the thread appears, the mp3 lands in it, and the "Back to
Top" link at the end of the thread opens its first message.

## What the workflow refuses to publish

`release.yml` gates every publish behind a `verify` job. Because what it
publishes is what production spawns, this workflow is a production gate, not
just a build.

| refuses when | why |
|---|---|
| tag ≠ `package.json` version | a `package.json` behind the tags makes `npm version patch` propose an already-taken tag |
| the tagged commit is not on `main` | `:latest` feeds production; only promoted code may claim it |
| CI's `test` check is not green for that exact commit | CI runs on push to main/next and on PRs — **never on tags** — so a tag on an unbuilt commit would otherwise publish untested |

The check asks the API whether CI passed rather than re-running it: seconds
instead of a run of native compiles, and a stronger claim — the run that
actually gated `main`, not a fresh one on a re-resolved dependency tree.

## Configuration this repo does not own

Production picks the image via `disrecordWorkerImage`, read by core-server at
`src/config/server.ts`. It is set in **two** places and, per the config-shadowing
rule, both must agree:

- `cfg-core-server/config/production.json`
- `orchestration/config-overrides/production.json` ← the one the running
  container actually reads

Both name `ghcr.io/crit-fumble/cfg-server-disrecord` — **so a normal release
changes neither file.** A digest pinned here (`…@sha256:<digest>`) is an incident
tool (freeze the fleet on a known-good build), not part of shipping.

## Rollback

`:latest` carries no version information once published, so rollback is
re-publishing, not reverting a config value:

1. Find the good build's tag on the [package
   page](https://github.com/orgs/Crit-Fumble/packages/container/package/cfg-server-disrecord).
2. Re-point `:latest` at it (run anywhere with registry access). It reaches only
   a server with no release picked yet; one already on the bad release keeps it
   until its host picks another:

```sh
docker pull   ghcr.io/crit-fumble/cfg-server-disrecord:<good-tag>
docker tag    ghcr.io/crit-fumble/cfg-server-disrecord:<good-tag> \
              ghcr.io/crit-fumble/cfg-server-disrecord:latest
docker push   ghcr.io/crit-fumble/cfg-server-disrecord:latest
```

Every build also publishes an immutable `sha-<short-sha>` tag, which is the
reliable way to identify what a given host is running when `:latest` is
ambiguous.
