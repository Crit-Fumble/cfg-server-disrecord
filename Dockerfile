# cfg-resesh — multi-mode Discord voice recording service.
# One image; entrypoint picks `gateway` or `worker` mode from CMD args.
FROM node:22-alpine AS build

WORKDIR /app

# System deps for native modules (sodium-native, @discordjs/opus).
RUN apk add --no-cache python3 make g++ libtool autoconf automake

COPY package.json package-lock.json* ./
RUN npm ci --omit=optional

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Runtime stage ────────────────────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app

# Runtime needs only the production node_modules + dist.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# Healthcheck targets the gateway's /health endpoint (worker mode skips).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-4400}/health || exit 1

ENV NODE_ENV=production
EXPOSE 4400

# Default to gateway mode; worker containers override CMD.
ENTRYPOINT ["node", "dist/index.js"]
CMD ["gateway"]
