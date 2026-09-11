/**
 * File-extension → Shiki language-id mapping for the review viewer's basic
 * syntax highlighting. Unknown extensions fall back to plain text, so the
 * map stays an allow-list rather than a guess machine.
 * @module dsh-diff-approval/client/lang
 */

/** Extension (lowercase, no dot) to Shiki language id. */
const EXTENSION_LANGS: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'typescript',
  jsx: 'typescript',
  mjs: 'typescript',
  cjs: 'typescript',
  py: 'python',
  json: 'json',
  jsonc: 'json',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
  markdown: 'markdown',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  cs: 'csharp',
  sql: 'sql',
  xml: 'xml',
  svg: 'xml',
  ini: 'ini',
  toml: 'toml',
  lua: 'lua',
  rb: 'ruby',
}

/**
 * Map a file path to a Shiki language id, or `undefined` for plain text.
 * @param path - the file path, any separator style.
 * @returns the language id, or `undefined` when unknown.
 */
export function langFromPath(path: string): string | undefined {
  const suffix = suffixOfPath(path)
  return suffix === undefined ? undefined : EXTENSION_LANGS[suffix]
}

/**
 * The lowercase extension of a file path, without the dot — the key a manual
 * language choice is remembered under. A name with no dot has no suffix, so a
 * per-suffix preference never leaks onto every extension-less file at once.
 * @param path - the file path, any separator style.
 * @returns the suffix, or `undefined` when the name carries none.
 */
export function suffixOfPath(path: string): string | undefined {
  const match = /\.([^./\\]+)$/.exec(path)
  const suffix = match?.[1]
  return suffix === undefined || suffix === '' ? undefined : suffix.toLowerCase()
}
