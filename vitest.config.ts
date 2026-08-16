import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The panel imports the published ui-primitives, whose dist drags in
    // katex CSS. Inline the harness packages so their CSS goes through the
    // transform pipeline, and process CSS in tests.
    css: true,
    environment: 'jsdom',
    server: {
      deps: {
        inline: [/@deepseek-ai/],
      },
    },
  },
})
