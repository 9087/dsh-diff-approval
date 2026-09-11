import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The panel imports the published ui-primitives, whose dist drags in
    // katex CSS. Inline the harness packages so their CSS goes through the
    // transform pipeline, and process CSS in tests.
    css: true,
    environment: 'jsdom',
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
