/**
 * cfg-server-disrecord configuration — env-driven.
 *
 * The container runs in `serve` mode: it opens a Discord voice connection
 * using a bot token supplied by the operator (self-host) or the consuming
 * bot (CFG-hosted), captures opus, mixes mp3, and (optionally) transcribes.
 * It runs local-only by default, or CFG-hosted when `CORE_SERVER_URL` is set.
 *
 * The bot token is the only long-lived credential and never leaves the
 * container; CFG-hosted per-session JWTs die with the container.
 */

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
 * The recording skill server: the container opens a Discord voice
 * connection with a borrowed bot token, joins voice, captures opus, mixes
 * mp3, and (optionally) transcribes — with ZERO core-server involvement in
 * self-host mode.
 *
 * Every value here is operator-supplied at `docker run` time. The bot
 * token is the only long-lived credential and never leaves the container.
 */
export interface StandaloneConfig {
  /**
   * Discord bot token the container logs in with at boot. Bot-agnostic —
   * self-host supplies their own bot's token; CFG-hosted injects the
   * ReSesh bot's token. Used only to join voice (no command surface).
   */
  discordToken: string
  /**
   * Deepgram API key. Absent ⇒ record-only mode: the container still
   * captures + mixes mp3, it just doesn't transcribe (no VTT, no thread
   * transcript). For `deepgramMode='byok'` this is the static key used
   * directly. For `'platform'` this is absent — the container mints
   * short-lived grant tokens from core-server instead.
   */
  deepgramKey?: string
  /**
   * Deepgram credential mode:
   *   platform — CFG-hosted with the platform key. The container fetches a
   *              short-lived grant token from core-server per websocket open.
   *   byok     — use `deepgramKey` directly (self-host, or a CFG user key).
   *   disabled — no transcription (record-only).
   * Resolved from the `DEEPGRAM_MODE` env var; when unset it is inferred —
   * `byok` if `DEEPGRAM_API_KEY` is present, `disabled` otherwise — so a
   * self-host operator never has to set it explicitly.
   */
  deepgramMode: 'platform' | 'byok' | 'disabled'
  /** Deepgram model. Defaults to 'nova-3'. */
  deepgramModel: string
  /** Deepgram transcription language. Defaults to 'en'. */
  deepgramLanguage: string
  /** Local directory finalized mp3 + VTT land in. Default `/data/recordings`. */
  outputDir: string
  /**
   * Real-time mp3 chunking cadence in minutes (#131). `0` (the default)
   * disables chunking — the session behaves exactly as before, producing only
   * the whole-session mp3 at stop(). When `> 0`, a chunk mp3 covering the last
   * window is posted into the transcript thread every N minutes (and on
   * pause/stop). Keep it small enough that a chunk stays under Discord's ~9 MB
   * cap (≈1 MB/min of mixed audio ⇒ 8 is a safe default when enabled).
   */
  chunkMinutes: number
  /** HTTP control-server port. Default 8080. */
  controlPort: number
  /**
   * Optional bearer token for the HTTP control API. When set, every
   * control request must carry `Authorization: Bearer <token>`. When
   * unset, the control server is unauthenticated (it binds 127.0.0.1
   * only in self-host mode, so this is acceptable for single-host).
   */
  controlToken?: string
  logLevel: string
  /**
   * CFG-hosted phone-home settings. Populated only when `CORE_SERVER_URL`
   * is set — when it is unset, `cfg` is `undefined` and every phone-home
   * path becomes a clean no-op. This is the blank-slate-boot guarantee:
   * a container with only a bot token never reaches core-server.
   */
  cfg?: CfgHostedConfig
}

/**
 * CFG-hosted configuration — present only when core-server spawned this
 * container. Drives billing ticks, object-storage upload, consent sync, and the
 * JWT-authenticated control API. Every field here is injected by
 * core-server's container spawner.
 */
export interface CfgHostedConfig {
  /** core-server base URL — billing/transcript/session-policy callbacks. */
  coreServerUrl: string
  /**
   * Per-session JWT minted by core-server (scope='disrecord-worker' +
   * installationId claim, HS256, signed with AUTH_SECRET). Used as the
   * bearer for outbound callbacks AND as the verification token for
   * inbound control-API requests.
   */
  coreServerToken: string
  /** Installation id — equals the RecordingSession id; keys all callbacks. */
  installationId: string
  /** Owning user — logging / billing attribution. */
  userId: string
  /** Worker-billing rate in CT/min, computed by core-server's slot-fraction formula. */
  ctPerMinute: number
  /** Container instance size — informational only. */
  size: string
  /**
   * Live-transcription surcharge rate in CT/min. PRESENCE is the signal that
   * this session runs on the platform Deepgram key and must incur a separate
   * itemized `transcription` billing tick (parallel to the `bot_container`
   * uptime tick). Absent ⇒ BYOK or transcription disabled ⇒ no surcharge.
   */
  transcriptionCtPerMinute?: number
  /** Object-storage credentials — when present the container uploads finalized mp3/VTT. */
  objectStorage?: ObjectStorageConfig
}

/**
 * S3-compatible object-storage credentials for the CFG-hosted upload sink.
 * Resolved from the `DO_SPACES_*` env vars (names kept for deployed-surface
 * compatibility; any S3-compatible endpoint works).
 */
export interface ObjectStorageConfig {
  key: string
  secret: string
  bucket: string
  region: string
  endpoint: string
}

/**
 * Resolve the optional CFG-hosted configuration block.
 *
 * Blank-slate-boot contract: returns `undefined` whenever `CORE_SERVER_URL`
 * is unset, so a self-host operator never accidentally trips a phone-home
 * code path. When `CORE_SERVER_URL` IS set, the remaining CFG vars are
 * required — a half-configured phone-home is a misconfiguration we want to
 * fail loudly at boot rather than silently degrade.
 *
 * Object-storage upload is independently optional: with `CORE_SERVER_URL`
 * but no `DO_SPACES_*`, the container phones home for billing/consent but
 * still stores recordings locally (the LocalDirSink path).
 */
export function resolveCfgHostedConfig(): CfgHostedConfig | undefined {
  const coreServerUrl = process.env.CORE_SERVER_URL
  if (!coreServerUrl) return undefined

  const ctPerMinRaw = process.env.DISRECORD_CT_PER_MIN
  const ctPerMinute = ctPerMinRaw ? Number(ctPerMinRaw) : 13
  if (!Number.isFinite(ctPerMinute) || ctPerMinute <= 0) {
    throw new Error(`Invalid DISRECORD_CT_PER_MIN: ${ctPerMinRaw}`)
  }

  // Transcription surcharge rate — optional. Injected by core-server only
  // when the recording's Deepgram mode is 'platform' (platform key). Absent
  // for BYOK or disabled transcription, in which case no surcharge is billed.
  const transcriptionRaw = process.env.DISRECORD_TRANSCRIPTION_CT_PER_MIN
  let transcriptionCtPerMinute: number | undefined
  if (transcriptionRaw !== undefined && transcriptionRaw !== '') {
    transcriptionCtPerMinute = Number(transcriptionRaw)
    if (!Number.isFinite(transcriptionCtPerMinute) || transcriptionCtPerMinute <= 0) {
      throw new Error(`Invalid DISRECORD_TRANSCRIPTION_CT_PER_MIN: ${transcriptionRaw}`)
    }
  }

  let objectStorage: ObjectStorageConfig | undefined
  const storageKey = process.env.DO_SPACES_KEY
  if (storageKey) {
    objectStorage = {
      key: storageKey,
      secret: requireEnv('DO_SPACES_SECRET'),
      bucket: requireEnv('DO_SPACES_BUCKET'),
      region: requireEnv('DO_SPACES_REGION'),
      endpoint: requireEnv('DO_SPACES_ENDPOINT'),
    }
  }

  return {
    coreServerUrl,
    coreServerToken: requireEnv('CORE_SERVER_TOKEN'),
    installationId: requireEnv('DISRECORD_INSTALLATION_ID'),
    userId: requireEnv('DISRECORD_USER_ID'),
    ctPerMinute,
    size: optionalEnv('DISRECORD_SIZE', 'small'),
    transcriptionCtPerMinute,
    objectStorage,
  }
}

export function resolveStandaloneConfig(): StandaloneConfig {
  const controlPortRaw = process.env.CONTROL_PORT
  const controlPort = controlPortRaw ? Number(controlPortRaw) : 8080
  if (!Number.isInteger(controlPort) || controlPort <= 0 || controlPort > 65535) {
    throw new Error(`Invalid CONTROL_PORT: ${controlPortRaw}`)
  }
  // Deepgram mode: explicit DEEPGRAM_MODE wins; otherwise infer from whether
  // a static key is present (self-host operators never set DEEPGRAM_MODE).
  const deepgramKey = process.env.DEEPGRAM_API_KEY || undefined
  const rawMode = process.env.DEEPGRAM_MODE
  let deepgramMode: 'platform' | 'byok' | 'disabled'
  if (rawMode === 'platform' || rawMode === 'byok' || rawMode === 'disabled') {
    deepgramMode = rawMode
  } else if (rawMode !== undefined && rawMode !== '') {
    throw new Error(`Invalid DEEPGRAM_MODE: ${rawMode}`)
  } else {
    deepgramMode = deepgramKey ? 'byok' : 'disabled'
  }

  // Real-time chunking cadence (#131). Unset/empty ⇒ 0 ⇒ disabled. Must be a
  // finite, non-negative number; a malformed value fails loudly at boot.
  const chunkRaw = process.env.DISRECORD_CHUNK_MINUTES
  const chunkMinutes = chunkRaw ? Number(chunkRaw) : 0
  if (!Number.isFinite(chunkMinutes) || chunkMinutes < 0) {
    throw new Error(`Invalid DISRECORD_CHUNK_MINUTES: ${chunkRaw}`)
  }

  return {
    discordToken: requireEnv('DISRECORD_DISCORD_TOKEN'),
    deepgramKey,
    deepgramMode,
    deepgramModel: optionalEnv('DEEPGRAM_MODEL', 'nova-3'),
    deepgramLanguage: optionalEnv('DEEPGRAM_LANGUAGE', 'en'),
    outputDir: optionalEnv('OUTPUT_DIR', '/data/recordings'),
    controlPort,
    controlToken: process.env.CONTROL_TOKEN || undefined,
    logLevel: optionalEnv('LOG_LEVEL', 'info'),
    chunkMinutes,
    cfg: resolveCfgHostedConfig(),
  }
}
