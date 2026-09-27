/**
 * A fresh identifier for a record the browser half mints.
 *
 * `crypto.randomUUID` is a SECURE CONTEXT API. Reaching this host from a phone or a tablet over the
 * LAN means plain HTTP, where `crypto.randomUUID` is undefined and calling it throws a TypeError —
 * synchronously, before the code around it does anything. That is how writing a comment died on a
 * tablet: the composer stayed open with the reader's words in it, nothing was sent, and no failure was
 * shown, because the throw happened before the request and outside the `try` that would have said so.
 * The desktop was never affected: `localhost` IS a secure context.
 *
 * `crypto.getRandomValues` carries no such restriction, so the fallback builds the id from it — a
 * version-4 UUID, the shape the host and the client both treat as opaque but which reads as one
 * everywhere it is printed. `randomUUID` is still preferred when it is there: it is the same thing
 * done by the platform.
 *
 * @returns an identifier, unique for practical purposes.
 */
export function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = new Uint8Array(16)
  if (typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes)
  else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256)
  // The two version/variant nibbles, so the fallback is a v4 UUID and not merely 16 random bytes.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
