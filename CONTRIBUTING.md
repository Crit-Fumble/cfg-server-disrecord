# Contributing to cfg-server-disrecord

DisRecord is a **skill server** — an HTTP-driven container that lets an *existing*
Discord bot record and transcribe a voice call. It is not a bot and has no
slash-command surface (see the README). This repo is self-contained: it does not
depend on any `@crit-fumble/*` package, so `npm install` needs no GitHub Packages
token.

## Local dev setup

You need **Node.js >= 24** (see `.nvmrc` / `engines`).

```bash
npm install
npm run dev          # tsx watch — serve mode
npm test
npm run typecheck
npm run build        # tsc + tsc-alias → dist/
```

Copy `.env.example` to `.env`. Whether the container runs **CFG-hosted** or
**local-only** (bring-your-own bot + Deepgram key) is decided purely by whether
`CORE_SERVER_URL` is set — the `.env.example` documents both modes.

`@discordjs/opus` ships a native binding; a local install may need
`npm rebuild @discordjs/opus`. Unit tests mock it, so they run without it.

> ℹ️  Actually recording audio end-to-end needs a real Discord bot token, a voice
> channel, and speaker **consent** — without consent DisRecord captures 0 bytes.
> Unit/typecheck cover most changes without any of that.

## Running tests

```bash
npm test           # jest
npm run typecheck  # tsc --noEmit
```

The `pre-push` Husky hook runs the full test suite (the `cfg-*` convention).
Don't bypass it with `--no-verify` — a red suite blocks the push for a reason.

## Commit messages & PRs

Use [Conventional Commits](https://www.conventionalcommits.org/)
(`feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `ci`, `build`). Fork, branch
from `main`, add tests for new behavior, run `npm run typecheck && npm test`
before pushing, and explain the *why* in the PR description.

## License

Contributions are accepted under [AGPL-3.0-only](./LICENSE). By submitting a PR
you agree your contribution may be distributed under that license.
