/**
 * cfg-server-disrecord worker configuration — env-driven.
 *
 * The repo used to ship a gateway mode too; that work moved into core-server
 * (services/disrecord/) when the standalone-gateway architecture was retired.
 * Everything here is now the worker container's view: how to reach core-server
 * for SSE opus + transcripts/billing callbacks, and per-session metadata
 * injected by core-server's worker-spawner.
 *
 * No long-lived secrets — every credential the worker sees is per-session
 * and dies with the container.
 */

export interface WorkerConfig {
  /** Worker's installation ID — recordingSession.id; keys all worker callbacks. */
  installationId: string
  /** Owning user — for logging only; billing attribution lives in core-server. */
  userId: string
  /** Discord guild — logging / metadata. */
  guildId: string
  /** Discord voice channel id — logging / metadata. */
  channelId: string
  /** Deepgram pricing route. */
  deepgramMode: 'platform' | 'byok' | 'disabled'
  /** Present only when deepgramMode='byok' — already-decrypted user key. */
  deepgramKey?: string
  /** core-server base URL — used for both SSE opus subscription and callback POSTs. */
  coreServerUrl: string
  /**
   * Per-session JWT minted by core-server at provisioning time.
   * scope='disrecord-worker' + installationId claim + exp; signed with AUTH_SECRET.
   * Gates the SSE subscription AND every callback. The worker holds no other
   * credential.
   */
  coreServerToken: string
  /** Container instance size — informational only; rate comes from `ctPerMinute`. */
  size: 'nano' | 'micro' | 'small'
  /**
   * Worker-billing rate in CT/min, computed by core-server's slot-fraction
   * formula at provision time (see cfg-core-server `container-sizing.ts`).
   * The worker bills this rate verbatim on each tick; it doesn't run its
   * own size→rate table anymore. core-server is the pricing source of
   * truth so the displayed rate, the worker's per-tick claim, and the
   * actual wallet debit all agree.
   */
  ctPerMinute: number
  logLevel: string
}

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback
}

/**
 * Standalone (`serve` mode) configuration — env-driven.
 *
 * Phase 1 of the unified-recording-container work: the container boots its
 * own Discord bot, joins voice, captures opus, mixes mp3, and (optionally)
 * transcribes — with ZERO core-server involvement. This is a separate
 * resolver from `resolveConfig()` (the legacy `worker` mode) so the two
 * modes don't share env validation; both ship in the same image.
 *
 * Every value here is operator-supplied at `docker run` time. The bot
 * token is the only long-lived credential and never leaves the container.
 */
export interface StandaloneConfig {
  /** ReSesh-style Discord bot token. The container logs in with this at boot. */
  discordToken: string
  /** Discord application (client) id — used for slash-command registration. */
  discordClientId: string
  /**
   * Deepgram API key. Absent ⇒ record-only mode: the container still
   * captures + mixes mp3, it just doesn't transcribe (no VTT, no thread
   * transcript). BYO key — the operator pays Deepgram directly.
   */
  deepgramKey?: string
  /** Deepgram model. Defaults to 'nova-3'. */
  deepgramModel: string
  /** Deepgram transcription language. Defaults to 'en'. */
  deepgramLanguage: string
  /** Local directory finalized mp3 + VTT land in. Default `/data/recordings`. */
  outputDir: string
  /** HTTP control-server port. Default 8080. */
  controlPort: number
  /**
   * Optional bearer token for the HTTP control API. When set, every
   * control request must carry `Authorization: Bearer <token>`. When
   * unset, the control server is unauthenticated (it binds 127.0.0.1
   * only in Phase 1, so this is acceptable for single-host self-host).
   */
  controlToken?: string
  logLevel: string
}

export function resolveStandaloneConfig(): StandaloneConfig {
  const controlPortRaw = process.env.CONTROL_PORT
  const controlPort = controlPortRaw ? Number(controlPortRaw) : 8080
  if (!Number.isInteger(controlPort) || controlPort <= 0 || controlPort > 65535) {
    throw new Error(`Invalid CONTROL_PORT: ${controlPortRaw}`)
  }
  return {
    discordToken: requireEnv('DISRECORD_DISCORD_TOKEN'),
    discordClientId: requireEnv('DISRECORD_DISCORD_CLIENT_ID'),
    deepgramKey: process.env.DEEPGRAM_API_KEY || undefined,
    deepgramModel: optionalEnv('DEEPGRAM_MODEL', 'nova-3'),
    deepgramLanguage: optionalEnv('DEEPGRAM_LANGUAGE', 'en'),
    outputDir: optionalEnv('OUTPUT_DIR', '/data/recordings'),
    controlPort,
    controlToken: process.env.CONTROL_TOKEN || undefined,
    logLevel: optionalEnv('LOG_LEVEL', 'info'),
  }
}

export function resolveConfig(): WorkerConfig {
  const size = optionalEnv('DISRECORD_SIZE', 'nano') as WorkerConfig['size']
  if (size !== 'nano' && size !== 'micro' && size !== 'small') {
    throw new Error(`Invalid DISRECORD_SIZE: ${size}`)
  }
  // core-server picks the rate and passes it in. Standalone-runs without
  // core-server (rare; mostly dev) fall back to a conservative default that
  // matches nano's slot-fraction price under the current $24 droplet.
  const ctPerMinRaw = process.env.DISRECORD_CT_PER_MIN
  const ctPerMinute = ctPerMinRaw ? Number(ctPerMinRaw) : 13
  if (!Number.isFinite(ctPerMinute) || ctPerMinute <= 0) {
    throw new Error(`Invalid DISRECORD_CT_PER_MIN: ${ctPerMinRaw}`)
  }
  return {
    installationId: requireEnv('DISRECORD_INSTALLATION_ID'),
    userId: requireEnv('DISRECORD_USER_ID'),
    guildId: requireEnv('DISRECORD_GUILD_ID'),
    channelId: requireEnv('DISRECORD_CHANNEL_ID'),
    deepgramMode: requireEnv('DISRECORD_DEEPGRAM_MODE') as WorkerConfig['deepgramMode'],
    deepgramKey: process.env.DISRECORD_DEEPGRAM_KEY,
    coreServerUrl: requireEnv('CORE_SERVER_URL'),
    coreServerToken: requireEnv('CORE_SERVER_TOKEN'),
    size,
    ctPerMinute,
    logLevel: optionalEnv('LOG_LEVEL', 'info'),
  }
}
