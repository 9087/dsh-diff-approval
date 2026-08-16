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
 * Tokenize `code` into per-line highlighted runs when `lang` names a
 * registered grammar; `undefined` means the caller renders its plain fallback.
 * Each run's color is a `--shiki-*` custom property, keeping token colors on
 * the harness theme's sheets. The trailing newline shiki appends as a final
 * empty line is dropped so the run count matches the caller's own line array.
 * @param code - the source text.
 * @param lang - the Shiki grammar id, or `undefined` for plain text.
 * @returns one entry per source line (each an array of runs), or `undefined` when unhighlightable.
 */
export function highlightLines(code: string, lang: string | undefined): HighlightSpan[][] | undefined {
  if (lang === undefined || code === '') return undefined
  // Unknown ids (an extension mapping bug, never user text) must miss instead
  // of throwing inside shiki.
  if (!highlighter().getLoadedLanguages().includes(lang)) return undefined
  const { tokens } = highlighter().codeToTokens(code, { lang, theme: 'css-variables' })
  // shiki tokenizes `a\nb` into two lines; a trailing newline (`a\n`) adds a
  // third, empty line the caller's own line array does not carry. Drop that
  // one terminator line so the two structures stay in step.
  const last = tokens[tokens.length - 1]
  const lines = tokens.length > 1 && last !== undefined && last.length === 0
    ? tokens.slice(0, -1)
    : tokens
  return lines.map(line => line.map(token => ({ text: token.content, style: { color: token.color } })))
}
