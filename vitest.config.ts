import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The panel imports the published ui-primitives, whose dist drags in
    // katex CSS. Inline the harness packages so their CSS goes through the
    // transform pipeline, and process CSS in tests.
    css: true,
    environment: 'jsdom',
    // Real work happens inside some specs: `tests/vcs-git.spec.ts` runs actual `git` against a
    // throwaway repo, and the panel spec drives a 9,000-line component while the other files run in
    // parallel. Vitest's 5s default is a load-sensitive line for those two — a run that overlaps
    // another one, or a slow disk, turns them red for reasons that have nothing to do with the code.
    // 20s keeps a genuinely slow test failing on time while leaving room for a loaded machine.
    //
    // This does NOT cover a blocked event loop: a spec that spins on its own microtasks (the
    // `undoNotice` runaway this suite hit) never lets the timer fire, so it has to be diagnosed from
    // the worker's behaviour instead (see AGENTS.md).
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Spell the include out (it replaces Vitest's default) so the opt-in
    // performance probes stay out of the suite entirely: they print numbers
    // instead of asserting them and take seconds. Run one on demand with
    // PERF_PROBE=1, e.g.
    //   $env:PERF_PROBE='1'; node ./node_modules/vitest/vitest.mjs run tests/perf-open-file.probe.tsx
    include: process.env.PERF_PROBE === '1'
      ? ['tests/**/*.spec.{ts,tsx}', 'tests/**/*.probe.{ts,tsx}']
      : ['tests/**/*.spec.{ts,tsx}'],
    server: {
      deps: {
        inline: [/@deepseek-ai/],
      },
    },
  },
})
