#!/usr/bin/env node
/**
 * `disrecord` CLI — operate a standalone recording container.
 *
 * Subcommands:
 *   serve              — boot the container (gateway + slash + control server)
 *   register-commands  — register /resesh slash commands globally (one-shot)
 *   status [id]        — query the local control server
 *   start              — start a recording via the control server
 *   stop <id>          — stop a recording via the control server
 *
 * `status` / `start` / `stop` talk to the control server over HTTP at
 * `http://127.0.0.1:${CONTROL_PORT}`, forwarding `CONTROL_TOKEN` when set.
 * They are convenience wrappers — the same actions are available via
 * `/resesh` slash commands and the raw HTTP API.
 */

import { logger } from './logger.js'
import { resolveStandaloneConfig } from './config.js'
import { registerCommands } from './discord/register-commands.js'

function controlBase(): { url: string; token?: string } {
  const port = process.env.CONTROL_PORT ?? '8080'
  return { url: `http://127.0.0.1:${port}`, token: process.env.CONTROL_TOKEN || undefined }
}

async function controlFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { url, token } = controlBase()
  const headers = new Headers(init.headers)
  headers.set('content-type', 'application/json')
  if (token) headers.set('authorization', `Bearer ${token}`)
  return fetch(`${url}${path}`, { ...init, headers })
}

async function cmdServe(): Promise<void> {
  const config = resolveStandaloneConfig()
  const { startStandalone } = await import('./standalone.js')
  await startStandalone(config)
}

async function cmdRegisterCommands(): Promise<void> {
  const config = resolveStandaloneConfig()
  await registerCommands(config.discordToken, config.discordClientId, logger)
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
  logger.info({ recordingId: id }, 'stop accepted — post-processing async')
}

export async function runCli(argv: string[]): Promise<void> {
  const sub = (argv[0] ?? '').toLowerCase()
  switch (sub) {
    case 'serve':
      await cmdServe()
      return
    case 'register-commands':
      await cmdRegisterCommands()
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
        'Usage: disrecord <serve|register-commands|status|start|stop>\n' +
          '  serve              boot the recording container\n' +
          '  register-commands  register /resesh slash commands\n' +
          '  status [id]        query active recordings\n' +
          '  start              start a recording (START_GUILD_ID + START_VOICE_CHANNEL_ID)\n' +
          '  stop <id>          stop a recording\n',
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
