/**
 * Throwaway-boot fixture: publish ONE live session carrying a completed user prompt and a completed assistant
 * reply, so the README figures can show a real Conversation without a model, a key, or a network.
 *
 * Mounted only in the screenshot profile, as a `--patch` overlay insert row whose name is
 * `./seed-screenshot-session.mjs`: `dsh-app-boot` rewrites a relative inserted name to a `file://` URL beside
 * the patch file, so this needs no package, no build and no `node_modules` link.
 *
 * Two host facts the shape below depends on (same as the reference `dsh-shell-progress` suite):
 *
 * - `ctx.sessions.create()` publishes a LIVE session. A session created outside the agent lifecycle persists
 *   nothing, which is fine: the screenshot host is throwaway and the test only needs the client to render it.
 * - `header.cwd` must be absolute and present, or the web client's follow rejects the session as "not found".
 *
 * The test opens it through the persisted client store (`localStorage['dsh.sessions.current']`), so the
 * session id is fixed here and also printed to the host log as a marker.
 */

/** Cordis plugin name; shows up in the host log. */
export const name = 'e2e-screenshot-session'

/** Host services this plugin needs before `apply` runs. */
export const inject = ['sessions']

/** Stable id, so a reload finds and reuses the same session. */
export const SESSION_ID = 'e2e-readme-shots-session'

/** The marker line the test waits for in the host log. */
export const MARKER = 'SCREENSHOT_E2E_SESSION='

/** The session's workspace root; the test's host helper exports it for exactly this. */
const CWD = process.env.DSH_E2E_WORKSPACE ?? process.cwd()

/** The language the host renders in; the seeded conversation must match the README being illustrated. */
const LOCALE = process.env.DSH_E2E_LOCALE ?? 'zh'

const PROMPT = LOCALE === 'en'
  ? 'Please review this round of homepage changes. Also check how the features table and the install list render in the Markdown preview.'
  : '帮我过一遍首页这次的改动。顺便确认一下 Markdown 预览里的功能表格和开发步骤列表渲染是否正常。'

const REPLY = LOCALE === 'en'
  ? [
    'I reviewed the homepage changes. The dark-theme switch and the new hero copy look consistent, and the README update matches them.',
    '',
    'In the Markdown preview the features table and the development list both keep their structure; I left a comment on the review notes where the changelog entry should be confirmed.',
  ].join('\n')
  : [
    '首页这轮的改动我看过了。暗色主题切换和新的首屏文案是配套的，README 的更新也和它们一致。',
    '',
    'Markdown 预览里的功能表格和开发步骤列表结构都正常；我在审阅备注上留了一条评论，确认一下 changelog 的措辞即可。',
  ].join('\n')

/**
 * Publish the fixture session with one finished turn.
 *
 * A `user/message` and an `assistant/message` are surface events: the runtime REQUIRES the append marker on
 * those.
 * @param ctx - the host context carrying the sessions service.
 */
export function apply(ctx) {
  if (ctx.sessions.get(SESSION_ID) !== undefined) return // idempotent across a re-apply
  const session = ctx.sessions.create(SESSION_ID, { meta: { cwd: CWD } })

  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', {
    id: 'msg-screenshot-user-1',
    role: 'user',
    content: [{ type: 'text', text: PROMPT }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      id: 'msg-screenshot-assistant-1',
      role: 'assistant',
      content: [{ type: 'text', text: REPLY }],
      source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
    },
    // A durable assistant settlement carries its compact stream; the session projection reads it (token
    // meter, "does this stream show anything"), so it cannot be omitted from a fabricated message.
    stream: [{ type: 'text-chunks', texts: [REPLY] }],
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  process.stdout.write(`${MARKER}${SESSION_ID}\n`)
}
