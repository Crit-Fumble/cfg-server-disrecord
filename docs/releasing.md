# Releasing DisRecord

Everything this repo owns to get a build into production.

## The contract

```
PR (version bump rides it) ──▶ next ──fast-forward──▶ main ──tag v*──▶ release.yml
                                                                          │
                                                            ghcr.io/crit-fumble/
                                                        cfg-server-disrecord:latest
                                                                          │
                                   core-server pulls, then spawns ────────┘
                                       the worker (next session)
```

`ghcr.io/crit-fumble/cfg-server-disrecord` is a **public** package, so no pull
secret is involved anywhere.

## Tagging deploys — at the next session, not immediately

Production spawns **`:latest`** (owner decision 2026-08-05), and core-server
pulls it before every spawn: `container-spawn.ts` passes `imagePull: 'always'`,
which `clients/container/client.ts` honours by calling `pullImage` ahead of
`createContainer` (falling back to the local copy if the registry is
unreachable — a stale worker beats no worker).

So **a worker release is: tag → wait for the image**. There is no deploy step
and no host command; the next recording session starts on the new build. A
session already running keeps its container until it ends.

> ⚠️ **This section used to say the opposite** — that `createContainer` never
> pulls, so a release needed a manual `docker pull` on the prod host. That was
> true when it was written and stopped being true when `imagePull: 'always'`
> landed. Verified against `client.ts:486-500` on 2026-08-08. If you are
> holding a checklist with a "refresh the host" step on it, drop that step.

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

The `verify` job refuses to publish on three independent conditions (see the
table below), and **every one of them fails AFTER the tag is pushed**, in a
workflow nobody is required to watch. A refused publish leaves `:latest` on the
PREVIOUS image while the tag exists and looks successful — so anything
downstream that assumes the new worker is live is now wrong, silently.

```sh
# the run must be SUCCESS, not just present
gh run list --repo Crit-Fumble/cfg-server-disrecord --workflow release.yml --limit 3

# and :latest must actually carry the new version
gh api /orgs/Crit-Fumble/packages/container/cfg-server-disrecord/versions \
  --jq '.[0].metadata.container.tags'
```

There is **no** step 5. Do not `docker pull` on the prod host — `imagePull:
'always'` means the next recording pulls it, and the ⚠️ note above explains why
that step was removed. If you are holding an older checklist, this is the step
it told you to run; drop it.

## What the workflow refuses to publish

`release.yml` gates every publish behind a `verify` job. Because `:latest` is
what production spawns, this workflow is a production gate, not just a build.

| refuses when | why |
|---|---|
| tag ≠ `package.json` version | the drift that left package.json on 0.2.8 while tags reached v0.2.21, where `npm version patch` proposes an already-taken tag |
| the tagged commit is not on `main` | `:latest` feeds production; only promoted code may claim it |
| CI's `test` check is not green for that exact commit | CI runs on push to main/next and on PRs — **never on tags** — so a tag on an unbuilt commit would otherwise publish untested |

The check asks the API whether CI passed rather than re-running it: seconds
instead of ~12 minutes of native compiles, and a stronger claim — the run that
actually gated `main`, not a fresh one on a re-resolved dependency tree.

## Configuration this repo does not own

Production picks the image via `disrecordWorkerImage`, read by core-server at
`src/config/server.ts`. It is set in **two** places and, per the config-shadowing
rule, both must agree:

- `cfg-core-server/config/production.json`
- `orchestration/config-overrides/production.json` ← the one the running
  container actually reads

Both should read `ghcr.io/crit-fumble/cfg-server-disrecord:latest`, and both do
today — **so a normal release changes neither file.** A version pinned here is
an incident tool (freeze the fleet on a known-good build), not part of shipping;
core-server only rolls `:latest` forward at spawn when the value *is* `:latest`.

## Rollback

`:latest` carries no version information once published, so rollback is
re-publishing, not reverting a config value:

1. Find the good build's tag on the [package
   page](https://github.com/orgs/Crit-Fumble/packages/container/package/cfg-server-disrecord).
2. Re-point `:latest` at it (run anywhere with registry access — the prod host
   picks it up at the next spawn, no host command):

```sh
docker pull   ghcr.io/crit-fumble/cfg-server-disrecord:v0.2.21
docker tag    ghcr.io/crit-fumble/cfg-server-disrecord:v0.2.21 \
              ghcr.io/crit-fumble/cfg-server-disrecord:latest
docker push   ghcr.io/crit-fumble/cfg-server-disrecord:latest
```

Every build also publishes an immutable `sha-<short-sha>` tag, which is the
reliable way to identify what a given host is running when `:latest` is
ambiguous.
