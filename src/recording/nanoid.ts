/**
 * Tiny URL-safe random id generator.
 *
 * The standalone container needs a recording-id generator but has no
 * database and no need for the full `nanoid` dependency — a 21-char
 * base64url id from `crypto.randomBytes` is collision-safe at the scale a
 * single self-host container records (a handful of sessions per day).
 */

import { randomBytes } from 'node:crypto'

const ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict'

/** Generate a URL-safe random id. Defaults to 21 characters. */
export function nanoid(size = 21): string {
  const bytes = randomBytes(size)
  let id = ''
  for (let i = 0; i < size; i++) {
    id += ALPHABET[bytes[i] & 63]
  }
  return id
}
