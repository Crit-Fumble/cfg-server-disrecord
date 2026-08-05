# Releasing DisRecord

Everything this repo owns to get a build into production, and an honest account
of the one step it does not.

## The contract

```
PR (version bump rides it) ──▶ next ──fast-forward──▶ main ──tag v*──▶ release.yml
                                                                          │
                                                            ghcr.io/crit-fumble/
                                                        cfg-server-disrecord:latest
                                                                          │
                                              prod host `docker pull` ────┘
                                                                          │
                                                core-server spawns the worker
```

`ghcr.io/crit-fumble/cfg-server-disrecord` is a **public** package, so no pull
secret is involved anywhere.

## ⚠️ Tagging alone does not deploy

Production spawns **`:latest`** (owner decision 2026-08-05). It is tempting to
read that as "tag and you're done". It is not, for a reason that is easy to miss:

core-server spawns the worker with dockerode's `createContainer`
(`cfg-core-server/src/services/disrecord/container-spawn.ts`), and **that API
never pulls**. It uses whatever `:latest` the host's Docker daemon already has,
and 404s if it has none. So publishing a new `:latest` changes nothing on the
host until something runs `docker pull`.

Today the only thing that does is `orchestration/scripts/deploy.sh`, whose own
comment says it plainly: *"the target host's local daemon keeps the last
`:latest` it pulled... silently runs against a stale worker until someone
manually pulls."*

**So a worker release is: tag → wait for the image → refresh the host.** Until
core-server pulls before spawning, the last step is manual and skipping it is
silent — the recording still works, it just runs the old code.

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

**4. Refresh the prod host** — the step tagging does not do (see above).

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

Both should read `ghcr.io/crit-fumble/cfg-server-disrecord:latest`. Note that
`deploy.sh` has always pulled `:latest`, so any pinned value there was pulling
one tag and spawning another — aligning both on `:latest` removes that mismatch.

## Rollback

`:latest` carries no version information once published, so rollback is
re-publishing, not reverting a config value:

1. Find the good build's tag on the [package
   page](https://github.com/orgs/Crit-Fumble/packages/container/package/cfg-server-disrecord).
2. Re-point `:latest` at it and refresh the host:

```sh
docker pull   ghcr.io/crit-fumble/cfg-server-disrecord:v0.2.21
docker tag    ghcr.io/crit-fumble/cfg-server-disrecord:v0.2.21 \
              ghcr.io/crit-fumble/cfg-server-disrecord:latest
docker push   ghcr.io/crit-fumble/cfg-server-disrecord:latest
```

Every build also publishes an immutable `sha-<short-sha>` tag, which is the
reliable way to identify what a given host is running when `:latest` is
ambiguous.
