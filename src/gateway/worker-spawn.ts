/**
 * WorkerSpawner — dockerode wrapper for creating, starting, and stopping
 * cfg-server-disrecord-worker containers.
 *
 * Container naming: cfg-server-disrecord-worker-<installationId>
 * Image: configured per gateway (DISRECORD_WORKER_IMAGE)
 * Network: same as gateway, so loopback HTTP works for the SSE callback
 * Port: dynamic (HostPort: 0); not exposed publicly — gateway-to-worker
 *   traffic is one-way (worker POSTs to core-server, doesn't accept inbound).
 */

import Docker from 'dockerode'
import type { Logger } from '../logger.js'

export interface SpawnParams {
  installationId: string
  userId: string
  guildId: string
  channelId: string
  size: 'nano' | 'micro' | 'small'
  /** Per-session bearer for the worker → gateway SSE audio subscription. */
  sessionToken: string
  /**
   * Per-session JWT for worker → core-server callbacks. Minted by core-server
   * (the AUTH_SECRET holder); gateway just relays it into the worker env.
   */
  workerToken: string
  deepgramMode: 'platform' | 'byok' | 'disabled'
  deepgramKey?: string
}

export interface SpawnResult {
  containerId: string
  containerName: string
  hostPort: number | null
}

export interface WorkerSpawnerParams {
  dockerSocketPath: string
  /** Docker image tag to run for workers. */
  workerImage: string
  /** URL workers use to subscribe to the gateway audio SSE. */
  gatewayUrl: string
  /** URL workers use to POST transcripts + billing back to core-server. */
  coreServerUrl: string
  /** Docker network for cross-container loopback (gateway ↔ worker). */
  network?: string
  logger?: Logger
}

/** Prefix every worker container with this so we can reconcile state from Docker. */
const WORKER_NAME_PREFIX = 'cfg-server-disrecord-worker-'

/** Container resource limits per size. CPU is in nanos; memory in bytes. */
const RESOURCE_LIMITS: Record<SpawnParams['size'], { CpuShares: number; Memory: number }> = {
  nano: { CpuShares: 512, Memory: 512 * 1024 * 1024 }, // 0.5 vCPU equiv, 512MB
  micro: { CpuShares: 512, Memory: 1024 * 1024 * 1024 }, // 0.5 vCPU, 1GB
  small: { CpuShares: 1024, Memory: 2 * 1024 * 1024 * 1024 }, // 1 vCPU, 2GB
}

export class WorkerSpawner {
  private docker: Docker

  constructor(private readonly params: WorkerSpawnerParams) {
    this.docker = new Docker({ socketPath: params.dockerSocketPath })
  }

  async spawn(opts: SpawnParams): Promise<SpawnResult> {
    const { logger } = this.params
    const containerName = `${WORKER_NAME_PREFIX}${opts.installationId}`

    // Build env. Only set DEEPGRAM_KEY when byok — platform key lives only
    // in core-server (worker doesn't need it for platform mode; transcripts
    // route through core-server which holds the key).
    const env: string[] = [
      `DISRECORD_GATEWAY_URL=${this.params.gatewayUrl}`,
      `DISRECORD_SESSION_TOKEN=${opts.sessionToken}`,
      `DISRECORD_INSTALLATION_ID=${opts.installationId}`,
      `DISRECORD_USER_ID=${opts.userId}`,
      `DISRECORD_GUILD_ID=${opts.guildId}`,
      `DISRECORD_CHANNEL_ID=${opts.channelId}`,
      `DISRECORD_DEEPGRAM_MODE=${opts.deepgramMode}`,
      `DISRECORD_SIZE=${opts.size}`,
      `CORE_SERVER_URL=${this.params.coreServerUrl}`,
      `CORE_SERVER_TOKEN=${opts.workerToken}`,
      'NODE_ENV=production',
    ]
    if (opts.deepgramMode === 'byok' && opts.deepgramKey) {
      env.push(`DISRECORD_DEEPGRAM_KEY=${opts.deepgramKey}`)
    }

    const limits = RESOURCE_LIMITS[opts.size]
    const container = await this.docker.createContainer({
      name: containerName,
      Image: this.params.workerImage,
      Cmd: ['worker'],
      Env: env,
      HostConfig: {
        NetworkMode: this.params.network,
        // Read-only root + tmpfs scratch per the plan's isolation goal
        ReadonlyRootfs: true,
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=64m' },
        CpuShares: limits.CpuShares,
        Memory: limits.Memory,
        RestartPolicy: { Name: 'no' },
        AutoRemove: true,
      },
      Labels: {
        'cfg.kind': 'disrecord-worker',
        'cfg.installationId': opts.installationId,
        'cfg.guildId': opts.guildId,
      },
    })

    await container.start()
    const inspected = await container.inspect()
    const containerId = inspected.Id
    // Worker doesn't expose a port to the host in Phase 0 (no inbound calls).
    const hostPort: number | null = null

    logger?.info({ containerId, containerName, installationId: opts.installationId }, 'worker container spawned')
    return { containerId, containerName, hostPort }
  }

  /**
   * Stop the worker container for an installation. Idempotent.
   * Sends SIGTERM with a grace period; if it doesn't exit, escalates to SIGKILL.
   */
  async stop(installationId: string, gracePeriodSec: number = 10): Promise<void> {
    const containerName = `${WORKER_NAME_PREFIX}${installationId}`
    try {
      const container = this.docker.getContainer(containerName)
      await container.stop({ t: gracePeriodSec }).catch(async (err: any) => {
        // 304 = container already stopped; OK.
        if (err?.statusCode === 304) return
        // 404 = container doesn't exist; OK.
        if (err?.statusCode === 404) return
        throw err
      })
    } catch (err) {
      this.params.logger?.warn({ err, installationId }, 'worker stop encountered error (best-effort)')
    }
  }

  /**
   * On gateway boot, list running worker containers and return their
   * installation IDs so the session-store can be rebuilt from Docker truth.
   */
  async reconcile(): Promise<Array<{ installationId: string; containerId: string; guildId: string }>> {
    const containers = await this.docker.listContainers({
      all: false,
      filters: { label: ['cfg.kind=disrecord-worker'] },
    })
    return containers.map((c) => ({
      installationId: c.Labels['cfg.installationId'] ?? '',
      containerId: c.Id,
      guildId: c.Labels['cfg.guildId'] ?? '',
    }))
  }
}

export const __testing__ = { WORKER_NAME_PREFIX, RESOURCE_LIMITS }
