# syntax=docker/dockerfile:1.7
#
# cfg-resesh — Discord voice recording service (gateway + worker)
#
# Two run modes selected by CMD: `gateway` (always-on) or `worker` (per session).
#
# Private @crit-fumble/* packages from GitHub Packages (per .npmrc) need a
# GitHub token at install time. Pass it as a BuildKit secret named `npmrc`:
#
#   docker build \
#     --secret id=npmrc,src=<(echo "//npm.pkg.github.com/:_authToken=$(gh auth token)") \
#     -t cfg-resesh:local .
#
# Base: node:24-slim (Debian/glibc). Matches cfg-core-server — needed because
# @discordjs/opus only ships x64-glibc prebuilds (no musl/alpine support).
# sodium-native ships arm64/x64-glibc prebuilds. Apple-silicon devs may compile
# @discordjs/opus from source via the toolchain in the deps stage.

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
RUN npm rebuild @discordjs/opus sodium-native

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

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-4400}/health || exit 1

ENV NODE_ENV=production
EXPOSE 4400

# Default to gateway mode; worker containers override CMD.
ENTRYPOINT ["node", "dist/index.js"]
CMD ["gateway"]
