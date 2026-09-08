/**
 * Whole-file diff model for the pending review viewer: one unified row list
 * over the complete old and new contents, so the viewer renders the entire
 * file with changed lines marked and unchanged lines as context. Pure
 * derivation; the panel owns rendering. The `diff` package is browser-safe.
 * @module dsh-diff-approval/client/whole-file-diff
 */

import { diffArrays, structuredPatch } from 'diff'

/** One rendered body line of the whole-file view. */
export interface WholeFileDiffRow {
  /** `context` lines are unchanged, `del`/`add` mark the removed/added sides. */
  kind: 'context' | 'del' | 'add'
  /** The line's text, without the terminating newline. */
  text: string
  /** 1-based line number on the old side; absent on `add` lines. */
  oldLine: number | undefined
  /** 1-based line number on the new side; absent on `del` lines. */
  newLine: number | undefined
}

/** The derived view: a flat row list plus the +/- totals. */
export interface WholeFileDiff {
  /** Body rows in file order; every line of both sides appears once. */
  rows: WholeFileDiffRow[]
  /** Number of removed lines. */
  removed: number
  /** Number of added lines. */
  added: number
}

/**
 * Compute the whole-file view between two contents. The context budget is the
 * side lengths, so every hunk covers the file and unchanged lines survive as
 * context rows; the `\ No newline at end of file` patch marker is annotation
 * and never becomes a row. Both sides are line-ending normalized (`\r\n?` →
 * `\n`) first, so a repo baseline stored with one EOL and a worktree with
 * another never show as a whole-file delete+add — the diff is about approved
 * content, not line-ending noise.
 * @param oldText - the file content before the pending change.
 * @param newText - the file content after the pending change.
 * @returns the complete row list with totals.
 */
/**
 * Normalize content for equality: line endings → `\n`, and a single trailing
 * newline is a terminator rather than a line. The result is the line bodies
 * joined by `\n` with no trailing newline, so representation-only differences
 * (EOL style, trailing-newline presence) compare equal.
 * @param text - the content to normalize.
 * @returns the normalized line bodies.
 */
export function contentKey(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n')
  return normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized
}

/** A changed middle larger than this many old×new line cells falls back to the
 *  greedy anchor alignment: the `diff` package's O((N+M)·D) Myers scan (and its
 *  high constant) would otherwise stall on a big, heavily-edited region for no
 *  benefit. */
const MIDDLE_CELL_CAP = 1_000_000

/** A fast, greedy line alignment for a large changed middle. Lines present on
 * both sides (in order) become context; a line only on one side is del/add;
 * two unmatched side-by-side lines are a replacement. It is O(N+M) (amortized,
 * with per-line index queues) and recognises unchanged lines as context, so a
 * big scattered file does not get marked as all-changed — it only gives up the
 * minimal-edit property Myers would provide. */
function alignLargeMiddle(
  midOld: string[],
  midNew: string[],
  start: number,
): { rows: WholeFileDiffRow[]; removed: number; added: number } {
  const rows: WholeFileDiffRow[] = []
  let removed = 0
  let added = 0
  const newPos = new Map<string, number[]>()
  const oldPos = new Map<string, number[]>()
  midNew.forEach((line, index) => { const q = newPos.get(line); if (q) q.push(index); else newPos.set(line, [index]) })
  midOld.forEach((line, index) => { const q = oldPos.get(line); if (q) q.push(index); else oldPos.set(line, [index]) })
  let oldLine = start
  let newLine = start
  let i = 0
  let j = 0
  while (i < midOld.length && j < midNew.length) {
    if (midOld[i] === midNew[j]) {
      rows.push({ kind: 'context', text: midOld[i]!, oldLine: ++oldLine, newLine: ++newLine })
      i++
      j++
      continue
    }
    const nxtNew = newPos.get(midOld[i]!)?.find(index => index >= j)
    const nxtOld = oldPos.get(midNew[j]!)?.find(index => index >= i)
    if (nxtNew !== undefined && (nxtOld === undefined || nxtNew - j <= nxtOld - i)) {
      for (let k = j; k < nxtNew; k++) { rows.push({ kind: 'add', text: midNew[k]!, oldLine: undefined, newLine: ++newLine }); added++ }
      j = nxtNew
    } else if (nxtOld !== undefined) {
      for (let k = i; k < nxtOld; k++) { rows.push({ kind: 'del', text: midOld[k]!, oldLine: ++oldLine, newLine: undefined }); removed++ }
      i = nxtOld
    } else {
      rows.push({ kind: 'del', text: midOld[i]!, oldLine: ++oldLine, newLine: undefined }); removed++
      i++
      rows.push({ kind: 'add', text: midNew[j]!, oldLine: undefined, newLine: ++newLine }); added++
      j++
    }
  }
  while (i < midOld.length) { rows.push({ kind: 'del', text: midOld[i]!, oldLine: ++oldLine, newLine: undefined }); removed++; i++ }
  while (j < midNew.length) { rows.push({ kind: 'add', text: midNew[j]!, oldLine: undefined, newLine: ++newLine }); added++; j++ }
  return { rows, removed, added }
}

/** Reorder each contiguous change run (a maximal run of non-context rows) into
 *  the standard unified-diff shape — all `del` rows first, then all `add` rows.
 *  The diff package's Myers scan can emit per-line replacements (`del add del
 *  add`) for some content, which reads as interleaved in the viewer and makes
 *  the split view pair each line separately. Reordering a run to del-block→add-
 *  block keeps each row's own line numbers and never changes the run's row
 *  boundaries, so change blocks, split alignment, and keep/revert ranges stay
 *  correct — it only tidies the display order. */
export function normalizeChangeRuns(rows: WholeFileDiffRow[]): void {
  for (let i = 0; i < rows.length;) {
    if (rows[i]!.kind === 'context') { i++; continue }
    const start = i
    while (i < rows.length && rows[i]!.kind !== 'context') i++
    const run = rows.slice(start, i)
    const dels = run.filter(row => row.kind === 'del')
    const adds = run.filter(row => row.kind === 'add')
    if (dels.length !== 0 && adds.length !== 0) {
      rows.splice(start, run.length)
      rows.splice(start, 0, ...dels, ...adds)
    }
  }
}

export function computeWholeFileDiff(oldText: string, newText: string): WholeFileDiff {
  const oldNorm = oldText.replace(/\r\n?/g, '\n')
  const newNorm = newText.replace(/\r\n?/g, '\n')
  // Identical content — possibly differing only by EOL style (normalized above)
  // or by the trailing newline (a terminator, not a line) — still shows every
  // line as context, never a spurious delete+add of the last line.
  if (contentKey(oldNorm) === contentKey(newNorm)) {
    const rows: WholeFileDiffRow[] = contentLines(oldNorm).map((text, index) => ({
      kind: 'context', text, oldLine: index + 1, newLine: index + 1,
    }))
    return { rows, removed: 0, added: 0 }
  }
  const oldLines = contentLines(oldNorm)
  const newLines = contentLines(newNorm)
  // Trim the common prefix and suffix first: the whole-file diff compares every
  // line only inside the changed middle. The `diff` package's Myers scan is
  // O((N+M)·D), which stalls on a large file when the whole thing is fed in;
  // trimming means a localized change diffs only its own hunk, so opening a big
  // edited file stays fast.
  let start = 0
  const minLen = Math.min(oldLines.length, newLines.length)
  while (start < minLen && oldLines[start] === newLines[start]) start++
  let endOld = oldLines.length
  let endNew = newLines.length
  while (start < endOld && start < endNew && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld--
    endNew--
  }
  const rows: WholeFileDiffRow[] = []
  let removed = 0
  let added = 0
  for (let i = 0; i < start; i++) rows.push({ kind: 'context', text: oldLines[i]!, oldLine: i + 1, newLine: i + 1 })
  const midOld = oldLines.slice(start, endOld)
  const midNew = newLines.slice(start, endNew)
  if (midOld.length === 0 && midNew.length === 0) {
    // No lines actually differ.
  } else if (midOld.length === 0) {
    for (let j = 0; j < midNew.length; j++) {
      rows.push({ kind: 'add', text: midNew[j]!, oldLine: undefined, newLine: start + j + 1 })
      added++
    }
  } else if (midNew.length === 0) {
    for (let i = 0; i < midOld.length; i++) {
      rows.push({ kind: 'del', text: midOld[i]!, oldLine: start + i + 1, newLine: undefined })
      removed++
    }
  } else if (midOld.length * midNew.length > MIDDLE_CELL_CAP) {
    // A big, heavily-edited middle: the Myers scan would stall, so align it
    // greedily instead (fast, and unchanged lines stay context).
    const aligned = alignLargeMiddle(midOld, midNew, start)
    rows.push(...aligned.rows)
    removed += aligned.removed
    added += aligned.added
  } else {
    const context = Math.max(1, midOld.length, midNew.length)
    const patch = structuredPatch('', '', midOld.join('\n'), midNew.join('\n'), undefined, undefined, { context })
    let oldLine = start
    let newLine = start
    for (const hunk of patch.hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith('\\')) continue
        if (line.startsWith('-')) {
          oldLine++
          rows.push({ kind: 'del', text: line.slice(1), oldLine, newLine: undefined })
          removed++
        } else if (line.startsWith('+')) {
          newLine++
          rows.push({ kind: 'add', text: line.slice(1), oldLine: undefined, newLine })
          added++
        } else {
          oldLine++
          newLine++
          rows.push({ kind: 'context', text: line.slice(1), oldLine, newLine })
        }
      }
    }
  }
  const suffixLen = oldLines.length - endOld
  for (let k = 0; k < suffixLen; k++) {
    rows.push({ kind: 'context', text: oldLines[endOld + k]!, oldLine: endOld + k + 1, newLine: endNew + k + 1 })
  }
  normalizeChangeRuns(rows)
  return { rows, removed, added }
}

/**
 * One intra-line segment of a changed line, used to highlight which characters
 * within a paired del/add line differ. A run is either unmarked context
 * (`same`) or the characters that were removed (`del`) /
 * added (`add`). Reassembling the runs of a del row in order yields the old
 * line's text; the runs of the paired add row yield the new line's text.
 */
export interface IntraRun {
  text: string
  kind: 'same' | 'del' | 'add'
}

/** Minimum similarity for a del/add pair to receive an intra-line diff. */
const INTRA_SIMILARITY_THRESHOLD = 0.4

/** Lines longer than this are skipped (a single pathological line would make the
 *  token-diff O(n²) and only ever show a noise floor). Mirrors the highlighting
 *  cap so a review stays bounded. */
const INTRA_MAX_LINE_LENGTH = 2000

/** A similarity-alignment block larger than this many cell-and-compare pairs
 *  falls back to by-order pairing: the O(n·m) scan and DP would stall on a
 *  whole-file rewrite for no benefit. */
const INTRA_MAX_ALIGN_CELLS = 8192

const WORD_CHAR_RE = /[\p{L}\p{N}_]/u

/** CJK characters — Chinese han, Japanese kana, CJK fullwidth forms. Each is an
 *  independent unit (there is no whitespace word boundary), so one token each. */
function isCJKCode(cp: number): boolean {
  return (cp >= 0x3040 && cp <= 0x30ff)
    || (cp >= 0x3400 && cp <= 0x4dbf)
    || (cp >= 0x4e00 && cp <= 0x9fff)
    || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe30 && cp <= 0xfe4f)
    || (cp >= 0xff00 && cp <= 0xffef)
    || (cp >= 0x20000 && cp <= 0x2fa1f)
}

/** Space, tab, or the ideographic space — whitespace is a break opportunity. */
function isSpaceCode(cp: number): boolean {
  return cp === 0x20 || cp === 0x09 || cp === 0x3000
}

/**
 * Tokenize a line for an intra-line diff, into a lossless array of tokens whose
 * concatenation equals the input. Word-based for space-delimited scripts: a
 * maximal run of letters/numbers/underscore (any script except CJK) is one
 * token, so a whole edited word stays a single run instead of per-character.
 * Each CJK character is its own token (there is no word boundary), as is each
 * punctuation/symbol character (a run of different punctuation carries no
 * meaning, so it diffs atomically), while a maximal whitespace run stays one
 * token as a natural break. This yields clean word-level highlights for English
 * and per-character precision for CJK and punctuation.
 * @param text - the line's content.
 * @returns the tokens.
 */
function tokenizeLine(text: string): string[] {
  const tokens: string[] = []
  let cur = ''
  let runKind: 'word' | 'space' | undefined
  const flush = (): void => { if (cur !== '') { tokens.push(cur); cur = '' } }
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    const word = WORD_CHAR_RE.test(ch)
    if (isCJKCode(cp) || (!word && !isSpaceCode(cp))) {
      // CJK or punctuation/symbol: an atomic token, one character each.
      flush()
      runKind = undefined
      tokens.push(ch)
      continue
    }
    const kind: 'word' | 'space' = word ? 'word' : 'space'
    if (kind !== runKind) { flush(); runKind = kind }
    cur += ch
  }
  flush()
  return tokens
}

/**
 * Raw similarity of a del/add line pair in `[0, 1]`, or `-1` when the pair
 * cannot be meaningfully compared (identical lines, either side empty, or over
 * the length cap). Used both by the intra-line gate and by the similarity
 * alignment, so the two always agree on what counts as "changed".
 * @param oldText - the removed side's line text.
 * @param newText - the added side's line text.
 * @returns the similarity ratio, or `-1` when incomparable.
 */
function lineSimilarity(oldText: string, newText: string): number {
  if (oldText === newText || oldText === '' || newText === '') return -1
  if (oldText.length > INTRA_MAX_LINE_LENGTH || newText.length > INTRA_MAX_LINE_LENGTH) return -1
  const changes = diffArrays(tokenizeLine(oldText), tokenizeLine(newText))
  const common = changes.reduce<number>(
    (sum, change) => (change.removed || change.added ? sum : sum + change.value.join('').length),
    0,
  )
  return (2 * common) / (oldText.length + newText.length)
}

/**
 * Compute the intra-line runs for one del/add line pair, or `undefined` when
 * the pair should not be annotated: identical lines (no internal change) or
 * lines too dissimilar to be a modification (a rewrite, not an edit).
 * Word-based via the `diff` package's `diffArrays` over `tokenizeLine`'s
 * tokens, so an English edit highlights whole changed words and a CJK edit
 * highlights the individual changed characters.
 * @param oldText - the removed side's line text.
 * @param newText - the added side's line text.
 * @returns the del-side and add-side runs, or `undefined` to skip annotation.
 */
export function intraRunsOf(
  oldText: string,
  newText: string,
): { del: IntraRun[]; add: IntraRun[] } | undefined {
  if (lineSimilarity(oldText, newText) < INTRA_SIMILARITY_THRESHOLD) return undefined
  const changes = diffArrays(tokenizeLine(oldText), tokenizeLine(newText))
  const del: IntraRun[] = []
  const add: IntraRun[] = []
  for (const change of changes) {
    const text = change.value.join('')
    if (change.removed) {
      del.push({ text, kind: 'del' })
    } else if (change.added) {
      add.push({ text, kind: 'add' })
    } else {
      del.push({ text, kind: 'same' })
      add.push({ text, kind: 'same' })
    }
  }
  // Skip only when neither side actually changed (identical lines, already
  // returned above): a pure extension has no removed run on the del side but an
  // added run on the add side, and must still be annotated — same for a pure
  // truncation (removed run on the del side, none on the add side).
  if (!del.some((run) => run.kind === 'del') && !add.some((run) => run.kind === 'add')) return undefined
  return { del, add }
}

/** One matched del→add row pair within a change block. */
interface BlockPair {
  delIndex: number
  addIndex: number
}

/** The alignment of one del/add change block: matched pairs and excess sides. */
export interface BlockAlignment {
  /** Matched del→add pairs, in file order. */
  pairs: BlockPair[]
  /** Row indices of unmatched deletions (shown as del-only in the split view). */
  delOnly: number[]
  /** Row indices of unmatched additions (shown as add-only in the split view). */
  addOnly: number[]
  /** True when similarity matching actually ran. False for a by-order block or a
   *  block too large to match — the caller then skips the intra-line highlight so
   *  alignment and highlighting are all-or-nothing (either both or neither). */
  usedSimilarity: boolean
}

/**
 * Align a del run with the following add run. By order (the baseline) pairs
 * `del[i]`↔`add[i]`. With similarity alignment, an order-preserving best match
 * pairs each del with the add that maximises total similarity, keeping a pair
 * only when it clears the similarity threshold — so a lone insert or delete in
 * a mixed block stays unaligned instead of being forced onto a wrong line.
 * @param delRows - the run's del rows (index + text).
 * @param addRows - the run's add rows (index + text).
 * @param alignBySimilarity - whether to use the similarity-based matching.
 * @returns the aligned pairs and the unmatched sides.
 */
export function alignChangedBlock(
  delRows: readonly { index: number; text: string }[],
  addRows: readonly { index: number; text: string }[],
  alignBySimilarity: boolean,
): BlockAlignment {
  const byOrder = (): BlockAlignment => {
    const min = Math.min(delRows.length, addRows.length)
    const pairs: BlockPair[] = []
    for (let i = 0; i < min; i++) pairs.push({ delIndex: delRows[i]!.index, addIndex: addRows[i]!.index })
    return { pairs, delOnly: delRows.slice(min).map(row => row.index), addOnly: addRows.slice(min).map(row => row.index), usedSimilarity: false }
  }
  if (!alignBySimilarity) return byOrder()
  const n = delRows.length
  const m = addRows.length
  // A giant block (a whole-file rewrite) would make the O(n·m) similarity scan
  // and DP pathological for no benefit: fall back to by-order pairing. This is
  // the "no" half of the all-or-nothing invariant — see `usedSimilarity` — so
  // the caller also skips the intra-line highlight for such a block.
  if (n * m > INTRA_MAX_ALIGN_CELLS) return byOrder()
  const sim: number[][] = []
  for (let i = 0; i < n; i++) {
    const row: number[] = []
    for (let j = 0; j < m; j++) row.push(lineSimilarity(delRows[i]!.text, addRows[j]!.text))
    sim.push(row)
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const skipDel = dp[i - 1]![j]!
      const skipAdd = dp[i]![j - 1]!
      const s = sim[i - 1]![j - 1]!
      const pair = s >= INTRA_SIMILARITY_THRESHOLD ? dp[i - 1]![j - 1]! + s : Number.NEGATIVE_INFINITY
      dp[i]![j] = Math.max(skipDel, skipAdd, pair)
    }
  }
  const pairs: BlockPair[] = []
  const delOnly: number[] = []
  const addOnly: number[] = []
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    const s = i > 0 && j > 0 ? sim[i - 1]![j - 1]! : Number.NEGATIVE_INFINITY
    if (i > 0 && j > 0 && s >= INTRA_SIMILARITY_THRESHOLD && dp[i]![j] === dp[i - 1]![j - 1]! + s) {
      pairs.push({ delIndex: delRows[i - 1]!.index, addIndex: addRows[j - 1]!.index })
      i--
      j--
    } else if (i > 0 && dp[i]![j] === dp[i - 1]![j]!) {
      delOnly.push(delRows[i - 1]!.index)
      i--
    } else if (j > 0) {
      addOnly.push(addRows[j - 1]!.index)
      j--
    } else {
      break
    }
  }
  pairs.reverse()
  delOnly.reverse()
  addOnly.reverse()
  return { pairs, delOnly, addOnly, usedSimilarity: true }
}

/**
 * Derive intra-line runs for a whole-file row list. Each del/add block is
 * aligned (by order, or by similarity when `alignBySimilarity`), and each
 * matched pair is compared by `intraRunsOf`. Returns a map keyed by the row's
 * index in `rows`, present only for rows that carry a highlight.
 * @param rows - the unified `WholeFileDiff` row list.
 * @param alignBySimilarity - align blocks by similarity instead of by order.
 * @returns per-row-index intra-line runs for annotated del/add rows.
 */
export function computeIntraLineDiff(
  rows: readonly WholeFileDiffRow[],
  alignBySimilarity = false,
): Map<number, IntraRun[]> {
  const result = new Map<number, IntraRun[]>()
  let i = 0
  while (i < rows.length) {
    if (rows[i]!.kind !== 'del') {
      i++
      continue
    }
    const delIndices: number[] = []
    while (i < rows.length && rows[i]!.kind === 'del') {
      delIndices.push(i)
      i++
    }
    const addIndices: number[] = []
    while (i < rows.length && rows[i]!.kind === 'add') {
      addIndices.push(i)
      i++
    }
    const alignment = alignChangedBlock(
      delIndices.map(index => ({ index, text: rows[index]!.text })),
      addIndices.map(index => ({ index, text: rows[index]!.text })),
      alignBySimilarity,
    )
    // Similarity alignment and its inline highlight are all-or-nothing: when a
    // block was too large and fell back to by-order (usedSimilarity is false in
    // similarity mode), skip the highlight too, so alignment and highlighting
    // are either both present or both absent.
    if (alignBySimilarity && !alignment.usedSimilarity) continue
    for (const pair of alignment.pairs) {
      const intra = intraRunsOf(rows[pair.delIndex]!.text, rows[pair.addIndex]!.text)
      if (intra !== undefined) {
        result.set(pair.delIndex, intra.del)
        result.set(pair.addIndex, intra.add)
      }
    }
  }
  return result
}

/**
 * Split a side's text into its content lines, with the diff card's terminator
 * rule: empty text is zero lines, and a single trailing newline is a line
 * terminator rather than an extra empty line.
 * @param text - the removed or added side's text.
 * @returns the content lines, without the terminating newline.
 */
function contentLines(text: string): string[] {
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n')
}
