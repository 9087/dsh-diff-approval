/**
 * Shared browser platform modules of the DeepSeek Harness web shell.
 * Copied from deepseek-harness `packages/client/web/src/platform.ts`
 * (MIT) so this plugin repo builds standalone; keep it in sync when the
 * harness's module table changes. The loader module table is a runtime
 * contract: every one of these specifiers is external at bundle time.
 * @module build/platform
 */

/** The module specifiers the shell shares into the frozen module table. */
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
] as const

/** One platform module specifier (a seed-table key). */
export type PlatformModule = (typeof PLATFORM_MODULES)[number]
