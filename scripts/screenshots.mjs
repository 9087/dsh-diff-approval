#!/usr/bin/env node
/**
 * Regenerate the README figures (`docs/images/*.png`) from the real plugin in a real browser.
 *
 * The work is done by `e2e/screenshots.spec.ts`, which is opt-in: this wrapper is what sets `README_SHOTS=1`
 * and runs that ONE spec, so an ordinary `pnpm e2e` never rewrites committed images.
 *
 * Requirements: the same as `pnpm e2e` — a built `lib/` (`pnpm run build`, the shell serves `lib/`, not `src/`)
 * and a `dsh` executable (set `DSH_BIN`, or have `dsh` on PATH).
 *
 * Usage:
 *   pnpm run build
 *   pnpm run screenshots
 *
 * The four figures (English `name.png` / Chinese `name.zh.png`), written into `docs/images/`:
 *   floating-panel    floating panel over a live session, HTML source diff
 *   docked-sidebar    the review docked in the right sidebar (≈ 2/3 of the window)
 *   markdown-preview  the structured Markdown preview, right sidebar in fullscreen mode
 *   comment-card      a comment card on the diff, in the same ≈ 2/3 docked layout
 *
 * The conversation in the docked figures comes from a fixture plugin (`e2e/fixtures/seed-screenshot-session.mjs`,
 * mounted with `--patch`): it publishes one live session with a finished user prompt and a finished assistant
 * reply, so the screenshots need no model, key or network.
 *
 * The spec also rewrites `screenshots.json` at the repository root with the files it captured.
 */
import { spawn } from 'node:child_process'

const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const child = spawn(command, ['exec', 'playwright', 'test', 'e2e/screenshots.spec.ts'], {
  stdio: 'inherit',
  env: { ...process.env, README_SHOTS: '1' },
  shell: process.platform === 'win32',
})
child.on('error', error => {
  console.error('[screenshots] could not start playwright:', error.message)
  process.exit(1)
})
child.on('exit', code => process.exit(code ?? 1))
