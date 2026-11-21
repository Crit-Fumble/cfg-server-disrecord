# Contributing to cfg-server-disrecord

What DisRecord is: the [README](README.md). This repo is self-contained: it does not
depend on any `@crit-fumble/*` package, so `npm install` needs no GitHub Packages
token.

## Local dev setup

You need the Node.js version in `.nvmrc` (and `engines`).

```bash
npm install
npm run dev          # tsx watch — serve mode
npm test
npm run typecheck
npm run build        # tsc + tsc-alias → dist/
```

Copy `.env.example` to `.env`; it documents both modes.

`@discordjs/opus` ships a native binding; a local install may need
`npm rebuild @discordjs/opus`. Unit tests mock it, so they run without it.

> ℹ️  Actually recording audio end-to-end needs a real Discord bot token, a voice
> channel, and speaker **consent** — without consent DisRecord captures 0 bytes.
> Unit/typecheck cover most changes without any of that.

## Running tests

The `pre-push` Husky hook runs the full test suite (the `cfg-*` convention).
Don't bypass it with `--no-verify` — a red suite blocks the push for a reason.

## Commit messages & PRs

Use [Conventional Commits](https://www.conventionalcommits.org/)
(`feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `ci`, `build`). Fork, branch
from `next` (the release-candidate branch — `main` is released truth and is
only ever fast-forwarded to), add tests for new behavior, run `npm run typecheck && npm test`
before pushing, and explain the *why* in the PR description.

## License

Contributions are accepted under [AGPL-3.0-only](./LICENSE). By submitting a PR
you agree your contribution may be distributed under that license.
