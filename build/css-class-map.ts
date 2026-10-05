/**
 * The class map a `x.module.css` import yields, as a DETERMINISTIC object.
 *
 * lightningcss hands `exports` back in an order that is not stable across runs
 * (its own map iteration), and the client bundle emits this table verbatim as
 * the module's default export, so that order used to leak into the artifact's
 * bytes: two builds of identical sources produced different bundles — same
 * length, same class names, same hashed values, merely permuted. That costs
 * more than a tidy diff: every "the artifact hash did not change" check across
 * builds is meaningless if the bytes are a lottery, and CI cannot cache or
 * compare what it cannot reproduce.
 *
 * Sorting by the SOURCE class name — not by the hashed value — makes the
 * emitted map a function of the stylesheet again, and it is the stable choice:
 * locals are what the author wrote, values carry a content hash that changes
 * with the file.
 *
 * This lives in its own module (rather than inside `tsdown.client.ts`) so the
 * unit test can import it: that file builds a repository-root URL at module
 * scope, which a test runner's `import.meta.url` cannot satisfy.
 */

/**
 * Build the emitted CSS-module class map with its keys in sorted order.
 * @param cssExports - lightningcss's `exports` table, keyed by the local name.
 * @returns the same mapping with keys in sorted order.
 */
export function cssClassMap(
  cssExports: Readonly<Record<string, { name: string }>> | undefined,
): Record<string, string> {
  const table = cssExports ?? {}
  const classMap: Record<string, string> = {}
  for (const local of Object.keys(table).sort()) {
    const entry = table[local]
    if (entry !== undefined) classMap[local] = entry.name
  }
  return classMap
}
