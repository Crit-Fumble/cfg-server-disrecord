/**
 * ReSesh slash command definitions.
 *
 * Ported from cfg-core-server's `services/disrecord/slash-commands.ts`.
 * Registered against the container's own Discord application via
 * `disrecord register-commands`.
 *
 * `default_member_permissions` is intentionally unset on /resesh — anyone
 * who can join the voice channel and post in the destination channel can
 * start a recording. The consent flow handles privacy.
 */

const startSubcommandOptions = [
  {
    name: 'channel',
    description: 'Text channel to post the transcript/recording into (defaults to current channel)',
    type: 7, // CHANNEL
    channel_types: [0], // GUILD_TEXT
    required: false,
  },
  {
    name: 'transcription',
    description: 'Include live transcription + VTT caption track on the MP3 (default: on)',
    type: 5, // BOOLEAN
    required: false,
  },
]

export const RESESH_COMMANDS = [
  {
    name: 'resesh',
    description: 'ReSesh — Discord voice recording with optional live transcription',
    options: [
      {
        name: 'start',
        description: 'Start recording the voice channel you are in',
        type: 1, // SUB_COMMAND
        options: startSubcommandOptions,
      },
      {
        name: 'pause',
        description: 'Pause the active recording (no audio captured)',
        type: 1,
      },
      {
        name: 'resume',
        description: 'Resume a paused recording',
        type: 1,
      },
      {
        name: 'stop',
        description: 'Stop the active recording and post the result',
        type: 1,
      },
      {
        name: 'status',
        description: 'Show the status of the active recording in this server',
        type: 1,
      },
    ],
  },
] as const
