# syntax=docker/dockerfile:1.7
#
# cfg-server-disrecord — per-session DisRecord worker container.
#
# Image is spawned by cfg-core-server's worker-spawner (one container per
# active recording session). Connects to core-server's SSE for opus audio,
# decodes opus → PCM, runs per-speaker Deepgram, POSTs transcripts +
# billing ticks back. Exits when the session ends.
#
# Private @crit-fumble/* packages from GitHub Packages (per .npmrc) need a
# GitHub token at install time. Pass it as a BuildKit secret named `npmrc`:
#
#   docker build \
#     --secret id=npmrc,src=<(echo "//npm.pkg.github.com/:_authToken=$(gh auth token)") \
#     -t cfg-server-disrecord:local .
#
# Base: node:24-slim (Debian/glibc). Matches cfg-core-server — @discordjs/opus
# only ships x64-glibc prebuilds (no musl/alpine support). Apple-silicon devs
# may need to compile @discordjs/opus from source via the toolchain in deps.

FROM node:24-slim AS base
WORKDIR /app

# ── Stage 1: deps ────────────────────────────────────────────────────────────
FROM base AS deps

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ ca-certificates

COPY .npmrc ./.npmrc.public
COPY package.json package-lock.json ./

RUN --mount=type=secret,id=npmrc \
    if [ -s /run/secrets/npmrc ]; then \
      cat .npmrc.public /run/secrets/npmrc > .npmrc; \
    fi && \
    npm ci --ignore-scripts && \
    if [ -f .npmrc.public ]; then mv .npmrc.public .npmrc; fi

# Rebuild native modules whose postinstall was skipped above.
RUN npm rebuild @discordjs/opus

# ── Stage 2: builder ─────────────────────────────────────────────────────────
FROM deps AS builder

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Stage 3: runtime ─────────────────────────────────────────────────────────
FROM base AS runtime

COPY --from=deps    /app/node_modules ./node_modules
COPY --from=builder /app/dist          ./dist
COPY --from=builder /app/package.json  ./package.json

ENV NODE_ENV=production

# Worker accepts no inbound HTTP (everything is outbound to core-server),
# so no EXPOSE / HEALTHCHECK is needed — health is implicit via the SSE
# subscription staying open from core-server's side.

ENTRYPOINT ["node", "dist/index.js"]
CMD ["worker"]
