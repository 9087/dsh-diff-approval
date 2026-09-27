import { defineConfig } from '@playwright/test'

/**
 * Real-browser E2E for the pending panel.
 *
 * These tests drive the actual DSH Web GUI in Chromium, with a throwaway `DSH_HOME`
 * (see `e2e/helpers/host.ts`), so they never touch the user's own sessions or the
 * plugin's real pending store. They are deliberately NOT part of `pnpm test`: the
 * suite needs a downloaded Chromium and a bootable `dsh`, so it runs only through
 * `pnpm run e2e`.
 *
 * One worker, no parallelism: every test in a file shares one host process and one
 * page (the undo/redo assertions are ordered steps of a single reviewer's story).
 */
export default defineConfig({
  testDir: 'e2e',
  // A test's first step can be a cold `dsh web` boot plus a Chromium launch.
  timeout: 240_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    viewport: { width: 1400, height: 900 },
    trace: 'off',
    video: 'off',
  },
  projects: [{ name: 'chromium' }],
})
