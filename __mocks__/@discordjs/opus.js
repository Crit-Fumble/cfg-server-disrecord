/**
 * Manual mock for @discordjs/opus — used in all jest runs so unit tests
 * don't require the native opus binding (which isn't rebuilt in CI). Lives
 * in a root-level __mocks__ adjacent to node_modules so jest auto-applies
 * it for any import of `@discordjs/opus`.
 */
class OpusEncoder {
  constructor() {}
  decode(opusBuf) {
    return Buffer.concat([Buffer.from('pcm:'), Buffer.from(opusBuf)])
  }
  encode(pcm) {
    return Buffer.from(pcm)
  }
}
module.exports = { OpusEncoder }
