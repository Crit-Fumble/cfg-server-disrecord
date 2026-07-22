#!/usr/bin/env node
/**
 * `disrecord` CLI — operate a recording skill-server container.
 *
 * Subcommands:
 *   serve              — boot the container (gateway + control server)
 *   status [id]        — query the local control server
 *   start              — start a recording via the control server
 *   stop <id>          — stop a recording via the control server
 *
 * `status` / `start` / `stop` talk to the control server over HTTP at
 * `http://127.0.0.1:${CONTROL_PORT}`, forwarding `CONTROL_TOKEN` when set.
 * They are convenience wrappers over the raw HTTP control API — the
 * container has no slash-command surface. A consuming bot that wants slash
 * commands (e.g. ReSesh) drives the container over this same API.
 */

import { logger } from './logger.js'

function controlBase(): { url: string; token?: string } {
  const port = process.env.CONTROL_PORT ?? '8080'
  return { url: `http://127.0.0.1:${port}`, token: process.env.CONTROL_TOKEN || undefined }
}

async function controlFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { url, token } = controlBase()
  const headers = new Headers(init.headers)
  // Only declare a JSON body when one is actually sent. Fastify rejects a
  // request that advertises `application/json` and then sends nothing, which
  // 400'd every bodyless POST (`stop`) before the route could run.
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  if (token) headers.set('authorization', `Bearer ${token}`)
  return fetch(`${url}${path}`, { ...init, headers })
}

async function cmdServe(): Promise<void> {
  const { resolveStandaloneConfig } = await import('./config.js')
  const { startStandalone } = await import('./standalone.js')
  await startStandalone(resolveStandaloneConfig())
}

async function cmdStatus(id?: string): Promise<void> {
  const res = await controlFetch(id ? `/v1/recordings/${id}` : '/v1/recordings')
  if (!res.ok) {
    logger.error({ status: res.status }, 'status request failed')
    process.exitCode = 1
    return
  }
  process.stdout.write(JSON.stringify(await res.json(), null, 2) + '\n')
}

async function cmdStart(): Promise<void> {
  const guildId = process.env.START_GUILD_ID
  const voiceChannelId = process.env.START_VOICE_CHANNEL_ID
  if (!guildId || !voiceChannelId) {
    logger.error('start requires START_GUILD_ID and START_VOICE_CHANNEL_ID env vars')
    process.exitCode = 2
    return
  }
  const res = await controlFetch('/v1/recordings', {
    method: 'POST',
    body: JSON.stringify({
      guildId,
      voiceChannelId,
      textChannelId: process.env.START_TEXT_CHANNEL_ID,
    }),
  })
  if (!res.ok) {
    logger.error({ status: res.status, body: await res.text() }, 'start request failed')
    process.exitCode = 1
    return
  }
  process.stdout.write(JSON.stringify(await res.json(), null, 2) + '\n')
}

async function cmdStop(id?: string): Promise<void> {
  if (!id) {
    logger.error('stop requires a recording id: disrecord stop <id>')
    process.exitCode = 2
    return
  }
  const res = await controlFetch(`/v1/recordings/${id}/stop`, { method: 'POST' })
  if (!res.ok) {
    logger.error({ status: res.status }, 'stop request failed')
    process.exitCode = 1
    return
  }
  // The stop route blocks until mix + upload + Discord post + cleanup finish,
  // so a 200 here means delivery is done — not merely accepted.
  logger.info({ recordingId: id }, 'stop complete — delivery finished')
}

export async function runCli(argv: string[]): Promise<void> {
  const sub = (argv[0] ?? '').toLowerCase()
  switch (sub) {
    case 'serve':
      await cmdServe()
      return
    case 'status':
      await cmdStatus(argv[1])
      return
    case 'start':
      await cmdStart()
      return
    case 'stop':
      await cmdStop(argv[1])
      return
    default:
      process.stderr.write(
        'Usage: disrecord <serve|status|start|stop>\n' +
          '  serve        boot the recording skill-server container\n' +
          '  status [id]  query active recordings\n' +
          '  start        start a recording (START_GUILD_ID + START_VOICE_CHANNEL_ID)\n' +
          '  stop <id>    stop a recording\n',
      )
      process.exitCode = sub ? 2 : 0
  }
}

// Direct invocation (the package `bin`). `src/index.ts` also delegates here.
const invokedDirectly = process.argv[1]?.endsWith('cli.js') || process.argv[1]?.endsWith('cli.ts')
if (invokedDirectly) {
  runCli(process.argv.slice(2)).catch((err) => {
    logger.fatal({ err }, 'cli failed')
    process.exit(1)
  })
}
