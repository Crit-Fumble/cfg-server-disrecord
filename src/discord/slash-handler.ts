/**
 * Slash-command interaction handler for the standalone container.
 *
 * Listens for `/resesh start|pause|resume|stop|status` interactions on the
 * container's own bot client and drives {@link RecordingService}. The
 * recording controls mirror the HTTP control API exactly — both surfaces
 * are thin shells over the same service.
 *
 * Permission model (per `project_resesh_permission_model`): recording is
 * gated on the invoker being connected to voice + the bot being able to
 * post in the target channel. There is no MANAGE_GUILD requirement; the
 * consent flow is the privacy gate.
 */

import { ChannelType, type ChatInputCommandInteraction, type Client, type Interaction } from 'discord.js'
import { GuildConflictError } from '../recording/recording-service.js'
import type { RecordingService } from '../recording/recording-service.js'
import type { Logger } from '../logger.js'

export function registerSlashHandler(
  client: Client,
  service: RecordingService,
  logger: Logger,
): void {
  client.on('interactionCreate', (interaction: Interaction) => {
    if (!interaction.isChatInputCommand()) return
    if (interaction.commandName !== 'resesh') return
    void handleResesh(interaction, service, logger).catch((err) => {
      logger.error({ err }, 'slash handler failed')
      if (!interaction.replied && !interaction.deferred) {
        void interaction.reply({ content: 'Something went wrong.', ephemeral: true }).catch(() => {})
      }
    })
  })
}

async function handleResesh(
  interaction: ChatInputCommandInteraction,
  service: RecordingService,
  logger: Logger,
): Promise<void> {
  const sub = interaction.options.getSubcommand()
  const guildId = interaction.guildId
  if (!guildId) {
    await interaction.reply({ content: 'ReSesh only works in a server.', ephemeral: true })
    return
  }

  switch (sub) {
    case 'start':
      await handleStart(interaction, service, guildId, logger)
      return
    case 'pause':
      await handleControl(interaction, service, guildId, 'pause')
      return
    case 'resume':
      await handleControl(interaction, service, guildId, 'resume')
      return
    case 'stop':
      await handleControl(interaction, service, guildId, 'stop')
      return
    case 'status':
      await handleStatus(interaction, service, guildId)
      return
    default:
      await interaction.reply({ content: `Unknown subcommand: ${sub}`, ephemeral: true })
  }
}

async function handleStart(
  interaction: ChatInputCommandInteraction,
  service: RecordingService,
  guildId: string,
  logger: Logger,
): Promise<void> {
  // Invoker must be connected to a voice channel.
  const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null)
  const voiceChannelId = member?.voice.channelId
  if (!voiceChannelId) {
    await interaction.reply({ content: 'Join a voice channel first, then run `/resesh start`.', ephemeral: true })
    return
  }

  const channelOpt = interaction.options.getChannel('channel')
  const textChannelId =
    channelOpt && channelOpt.type === ChannelType.GuildText
      ? channelOpt.id
      : interaction.channelId
  const transcription = interaction.options.getBoolean('transcription') ?? true

  await interaction.deferReply({ ephemeral: true })
  try {
    const recordingId = await service.start({
      guildId,
      voiceChannelId,
      textChannelId,
      transcription,
      invokerUserId: interaction.user.id,
    })
    await interaction.editReply(`Recording started (\`${recordingId}\`). Consent prompts posted.`)
  } catch (err) {
    if (err instanceof GuildConflictError) {
      await interaction.editReply('A recording is already active in this server. Use `/resesh stop` first.')
      return
    }
    logger.error({ err, guildId }, 'recording start failed')
    await interaction.editReply(`Could not start recording: ${err instanceof Error ? err.message : 'unknown error'}`)
  }
}

async function handleControl(
  interaction: ChatInputCommandInteraction,
  service: RecordingService,
  guildId: string,
  action: 'pause' | 'resume' | 'stop',
): Promise<void> {
  const session = service.describeByGuild(guildId)
  if (!session) {
    await interaction.reply({ content: 'No active recording in this server.', ephemeral: true })
    return
  }
  if (action === 'pause') service.pause(session.recordingId)
  else if (action === 'resume') service.resume(session.recordingId)
  else service.stop(session.recordingId)

  const verb = action === 'pause' ? 'paused' : action === 'resume' ? 'resumed' : 'stopping — the result will post shortly'
  await interaction.reply({ content: `Recording ${verb}.`, ephemeral: true })
}

async function handleStatus(
  interaction: ChatInputCommandInteraction,
  service: RecordingService,
  guildId: string,
): Promise<void> {
  const session = service.describeByGuild(guildId)
  if (!session) {
    await interaction.reply({ content: 'No active recording in this server.', ephemeral: true })
    return
  }
  const elapsedMin = Math.round((Date.now() - session.startedAt) / 60_000)
  await interaction.reply({
    content:
      `Recording \`${session.recordingId}\` — status: **${session.status}**, ` +
      `${elapsedMin}m elapsed, ${session.speakerCount} speaker(s).`,
    ephemeral: true,
  })
}
