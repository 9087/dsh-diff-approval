/**
 * Basic syntax highlighting for the review viewer. A single synchronous
 * fine-grained shiki core (JavaScript regex engine — no oniguruma WASM) with a
 * fixed grammar set, all imported eagerly: the plugin serves one client bundle
 * and must not code-split. Colors live in the harness theme's token sheets as
 * `--shiki-*` custom properties via the CSS-variables theme, so token colors
 * resolve against the web UI's existing vocabulary with no stylesheet of this
 * package's own. An unknown or absent language falls back to plain text —
 * never an error.
 * @module dsh-diff-approval/client/highlight
 */

import type { CSSProperties } from 'react'
import { createCssVariablesTheme, createHighlighterCoreSync } from 'shiki/core'
import type { HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine, defaultJavaScriptRegexConstructor } from 'shiki/engine/javascript'
// Grammar set: the languages a review panel commonly meets. Each module is a
// static import (the plugin serves one client bundle and must not code-split).
import langC from '@shikijs/langs/c'
import langCpp from '@shikijs/langs/cpp'
import langCsharp from '@shikijs/langs/csharp'
import langCss from '@shikijs/langs/css'
import langGo from '@shikijs/langs/go'
import langHtml from '@shikijs/langs/html'
import langIni from '@shikijs/langs/ini'
import langJava from '@shikijs/langs/java'
import langJson from '@shikijs/langs/json'
import langLua from '@shikijs/langs/lua'
import langMarkdown from '@shikijs/langs/markdown'
import langPython from '@shikijs/langs/python'
import langRuby from '@shikijs/langs/ruby'
import langRust from '@shikijs/langs/rust'
import langScss from '@shikijs/langs/scss'
import langShellscript from '@shikijs/langs/shellscript'
import langSql from '@shikijs/langs/sql'
import langToml from '@shikijs/langs/toml'
import langTypescript from '@shikijs/langs/typescript'
import langXml from '@shikijs/langs/xml'
import langYaml from '@shikijs/langs/yaml'

/** One highlighted run of a line: literal text plus a color style. */
export interface HighlightSpan {
  text: string
  style: CSSProperties
}

/** One file's highlight runs, one entry per side and line (index = line - 1). A
 *  hole means that line has not been highlighted — the viewer renders it plain,
 *  which is the honest state of a windowed highlighter: only what has been looked
 *  at is tokenized. */
export interface HighlightSides {
  oldRuns: HighlightSpan[][]
  newRuns: HighlightSpan[][]
}

/** A saved grammar state: resuming from one continues tokenization *exactly*
 *  where it stopped, instead of assuming the window's first line starts the file.
 *  Opaque to callers — only `highlightWindow` produces and consumes it, and
 *  `undefined` means "no saved state" (the file's first line is top-level). */
export type HighlightState = Parameters<HighlighterCore['codeToTokens']>[1]['grammarState']

/** One highlighted window: the requested lines' runs and the grammar state after
 *  the last of them, for an exact continuation by the next window. */
export interface HighlightWindow {
  runs: HighlightSpan[][]
  state: HighlightState
}

/** Options for {@link highlightWindow}. */
export interface HighlightWindowOptions {
  /** Lines of preceding context to run the grammar over without returning them,
   *  so a window starting inside a multi-line construct (a block comment, a
   *  template literal, a fenced code block) still colours correctly. Ignored when
   *  `state` is given: that one is exact. */
  context?: number
  /** An exact state saved at this window's first line (a previous window's
   *  `state`). */
  state?: HighlightState
}

/**
 * Tokenize guards: the viewer must never let the synchronous JS-regex engine
 * block the main thread on a hostile file. Lines above the length cap are
 * returned plain by shiki, the per-line budget caps a single pathological line,
 * and a window whose own text is enormous degrades to plain. Windows are what
 * keeps this bounded in the first place — the viewer never tokenizes more than
 * the lines it is about to show (see the windowed highlight hook), so a huge
 * file is no longer skipped wholesale: it is highlighted a screen at a time.
 */
const MAX_LINE_LENGTH = 2000
const TOKENIZE_TIME_LIMIT_MS = 100
const MAX_WINDOW_CHARS = 500_000

/**
 * Bounded tokenize cache keyed by the window's own text and language: scrolling
 * back over a window that was just highlighted reuses its runs instead of
 * re-running the engine. Insertion-ordered, so the oldest entry is evicted first;
 * 24 entries bounds both memory and the eviction cost. Windows highlighted from a
 * saved grammar state are not cached (the state is opaque, so it cannot be part
 * of the key).
 */
const TOKENIZE_CACHE_MAX = 24
const tokenizeCache = new Map<string, HighlightSpan[][]>()

/** All grammars this bundle registers; each entry's own `name` is the tokenize id. */
const LANGS = [
  langC,
  langCpp,
  langCsharp,
  langCss,
  langGo,
  langHtml,
  langIni,
  langJava,
  langJson,
  langLua,
  langMarkdown,
  langPython,
  langRuby,
  langRust,
  langScss,
  langShellscript,
  langSql,
  langToml,
  langTypescript,
  langXml,
  langYaml,
]

/**
 * Primary grammar ids offered in the viewer's language selector, in picker
 * order (alphabetical). Kept explicit instead of deriving from `LANGS`: some
 * `@shikijs/langs` modules are composite grammars whose `.name` arrays expose
 * embedded sub-grammars (e.g. C++ → `[regexp, glsl, cpp-macro, cpp]`,
 * TypeScript → `[typescript, jsx, tsx, graphql]`), which would otherwise leak
 * ids like `regexp`, `glsl`, `haml` into the menu. `LANGS` still registers the
 * full grammars (including their embedded languages) for highlighting.
 */
export const HIGHLIGHT_LANGS = [
  'c',
  'cpp',
  'csharp',
  'css',
  'go',
  'html',
  'ini',
  'java',
  'json',
  'lua',
  'markdown',
  'python',
  'ruby',
  'rust',
  'scss',
  'shellscript',
  'sql',
  'toml',
  'typescript',
  'xml',
  'yaml',
]

/** Display names for the grammar ids: shiki ids are lowercase, so the picker
    and trigger show conventional casing ("TypeScript", "C#", "Shell", …). */
const LANGUAGE_DISPLAY_NAMES: Record<string, string> = {
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  css: 'CSS',
  go: 'Go',
  html: 'HTML',
  ini: 'INI',
  java: 'Java',
  json: 'JSON',
  lua: 'Lua',
  markdown: 'Markdown',
  python: 'Python',
  ruby: 'Ruby',
  rust: 'Rust',
  scss: 'SCSS',
  shellscript: 'Shell',
  sql: 'SQL',
  toml: 'TOML',
  typescript: 'TypeScript',
  xml: 'XML',
  yaml: 'YAML',
}

/** Conventional display name for a grammar id, falling back to the id itself. */
export function languageDisplayName(id: string): string {
  return LANGUAGE_DISPLAY_NAMES[id] ?? id
}

/** All token colors resolve through `--shiki-*` custom properties (theme package sheets). */
const cssVariablesTheme = createCssVariablesTheme({
  name: 'css-variables',
  variablePrefix: '--shiki-',
  fontStyle: true,
})

/**
 * The client regex engine compiles each TextMate pattern when its scanner is
 * created. Shiki otherwise defers patterns longer than 3,000 characters until
 * their first match; eager compilation keeps the per-line scan budget for user
 * content instead of pattern compilation.
 */
const regexEngine = createJavaScriptRegexEngine({
  forgiving: true,
  regexConstructor: pattern => defaultJavaScriptRegexConstructor(pattern, {
    lazyCompileLength: Number.POSITIVE_INFINITY,
  }),
})

let singleton: HighlighterCore | undefined

/** Representative samples through the most common grammars, compiled before user content is timed. */
const WARMUPS = [
  { lang: 'typescript', code: 'const answer: number = 42' },
  { lang: 'shellscript', code: 'printf \'%s\\n\' "$HOME"' },
  { lang: 'json', code: '{"ready":true}' },
] as const

/** Construct and pre-tokenize the frequent grammars outside the user-content scan budget. */
function createHighlighter(): HighlighterCore {
  const instance = createHighlighterCoreSync({
    themes: [cssVariablesTheme],
    langs: LANGS,
    engine: regexEngine,
  })
  for (const sample of WARMUPS) {
    instance.codeToTokens(sample.code, {
      lang: sample.lang,
      theme: 'css-variables',
      tokenizeTimeLimit: 0,
    })
  }
  return instance
}

/** The synchronous highlighter (one instance per document); pre-warmed below, lazy as the fallback. */
function highlighter(): HighlighterCore {
  singleton ??= createHighlighter()
  return singleton
}

// Engine + grammar construction costs a long task; warming in a deferred task
// at module load keeps the first diff paint off that cost. `unref` (Node-only)
// keeps a non-browser import from pinning the event loop.
const warmupTimer = setTimeout(() => { highlighter() }, 0)
;(warmupTimer as { unref?: () => void }).unref?.()

/**
 * Tokenize the lines `[from, to)` into per-line highlighted runs when `lang`
 * names a registered grammar; `undefined` means the caller renders its plain
 * fallback. Each run's color is a `--shiki-*` custom property, keeping token
 * colors on the harness theme's sheets. The trailing newline shiki appends as a
 * final empty line is dropped so the run count matches the caller's own array.
 *
 * This is the viewer's only entry point, and it is deliberately windowed: the
 * code view renders a virtual window of rows, so highlighting a whole file to
 * show one screenful is almost all waste (measured on a 3818-line file: ~945 ms
 * for both sides whole-file against ~8 ms for one window). A window is continued
 * *exactly* from a previous one's `state`, or approximately from `context` lines
 * when no state is known yet — which is what lets a jump straight to the middle
 * of a file colour correctly without tokenizing anything above it.
 * @param lines - the side's lines, indexed from 0 as the caller's line numbers are.
 * @param lang - the Shiki grammar id, or `undefined` for plain text.
 * @param from - the first line index to highlight (inclusive, clamped).
 * @param to - one past the last line index to highlight (clamped).
 * @param options - the grammar state to resume from and/or context lines for the grammar.
 * @returns the window's runs and its end state, or `undefined` when the language
 *   is unknown, the range is empty, or the window's own text is too large.
 */
export function highlightWindow(
  lines: readonly string[],
  lang: string | undefined,
  from: number,
  to: number,
  options: HighlightWindowOptions = {},
): HighlightWindow | undefined {
  if (lang === undefined) return undefined
  // Unknown ids (an extension mapping bug, never user text) must miss instead
  // of throwing inside shiki.
  if (!highlighter().getLoadedLanguages().includes(lang)) return undefined
  const start = Math.max(0, Math.min(from, lines.length))
  const end = Math.max(start, Math.min(to, lines.length))
  if (end === start) return undefined
  // A saved state makes the window exact and needs no context; without one, the
  // lines just above it are run through the grammar so a multi-line construct
  // that began above the window still colours correctly inside it.
  const context = options.state === undefined ? Math.max(0, options.context ?? 0) : 0
  const contextFrom = Math.max(0, start - context)
  // The window is exactly the caller's own lines, joined: a file whose text ends
  // with a newline has a final empty line in that array, and shiki hands it back
  // as an empty token line — which is *in step*, so nothing is dropped here (the
  // whole-text API this replaced had to drop shiki's terminator line; a line array
  // already carries it or not, exactly as the caller counts lines).
  const text = lines.slice(contextFrom, end).join('\n')
  if (text.length > MAX_WINDOW_CHARS) return undefined
  const spans = end - start
  const cacheKey = options.state === undefined
    ? `${lang}\u0000${contextFrom}\u0000${text}`
    : undefined
  const cached = cacheKey === undefined ? undefined : tokenizeCache.get(cacheKey)
  // A hit must cover the same window size: the key carries the context start and
  // the text, so the only way to reach here with a different size is a code edit.
  if (cached !== undefined && cached.length === spans) return { runs: cached, state: undefined }
  const { tokens, grammarState } = highlighter().codeToTokens(text, {
    lang,
    theme: 'css-variables',
    // Cap a single line's engine time and skip pathological long lines
    // entirely; both degrade that line to plain instead of throwing.
    tokenizeTimeLimit: TOKENIZE_TIME_LIMIT_MS,
    tokenizeMaxLineLength: MAX_LINE_LENGTH,
    ...(options.state === undefined ? {} : { grammarState: options.state }),
  })
  const runs = tokens
    .slice(start - contextFrom)
    .map(line => line.map(token => ({ text: token.content, style: { color: token.color } })))
  if (cacheKey !== undefined) {
    if (tokenizeCache.size >= TOKENIZE_CACHE_MAX) {
      const oldest = tokenizeCache.keys().next().value
      if (oldest !== undefined) tokenizeCache.delete(oldest)
    }
    tokenizeCache.set(cacheKey, runs)
  }
  return { runs, state: grammarState }
}
