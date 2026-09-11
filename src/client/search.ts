/**
 * The in-file search matcher, shared by the unified diff and the split view so
 * both highlight and count the same occurrences.
 * @module dsh-diff-approval/client/search
 */

/** Which occurrences an in-file search accepts. */
export interface SearchOptions {
  /** Match the query's letter case exactly. */
  caseSensitive: boolean
  /** Accept only whole words (no identifier character touching either end). */
  wholeWord: boolean
}

/** The plain search: case-insensitive, substring. */
export const DEFAULT_SEARCH_OPTIONS: SearchOptions = { caseSensitive: false, wholeWord: false }

/**
 * Whether `at` holds an identifier character (the ASCII set editors use), or
 * false outside the string, so a match at either edge counts as a whole word.
 * @param text - the searched line.
 * @param at - the character index to test.
 * @returns whether that position is part of a word.
 */
function isWordCharAt(text: string, at: number): boolean {
  if (at < 0 || at >= text.length) return false
  return /[A-Za-z0-9_]/.test(text.charAt(at))
}

/**
 * Character ranges of every occurrence of `query` in `text` that the options
 * accept. Case-insensitive and substring-based unless narrowed.
 * @param text - the line to search.
 * @param query - the search text; empty matches nothing.
 * @param options - case and whole-word narrowing.
 * @returns `[start, end)` ranges in ascending order.
 */
export function matchRangesOf(
  text: string,
  query: string,
  options: SearchOptions = DEFAULT_SEARCH_OPTIONS,
): [number, number][] {
  if (query === '') return []
  const haystack = options.caseSensitive ? text : text.toLowerCase()
  const needle = options.caseSensitive ? query : query.toLowerCase()
  const out: [number, number][] = []
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) return out
    const end = at + needle.length
    // Whole-word means neither end of the match touches an identifier character;
    // a rejected occurrence still advances, so a "foo" query cannot re-match the
    // "foo" inside "foobar" at the same offset.
    if (!options.wholeWord || (!isWordCharAt(text, at - 1) && !isWordCharAt(text, end))) {
      out.push([at, end])
    }
    from = end
  }
}
