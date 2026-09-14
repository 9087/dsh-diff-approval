/**
 * The one skill this plugin offers the agent: how to answer a diff comment.
 *
 * The rules live here rather than in the system prompt. The harness's own `skill`
 * tool advertises every registered skill's name and description as a context message
 * and loads the body on demand, so the long form costs nothing until a comment is
 * actually being answered — and nothing this plugin registers can leak into unrelated
 * turns the way a global system-prompt section would.
 *
 * The comment prompt itself still carries the short version (see
 * `discussion.promptRule` in `src/client/locales.ts`) and names this skill, so the
 * behavior survives a build whose harness has no skill registry at all. The two are
 * kept in step by a test in `tests/diff-approval.spec.ts`.
 */

/** The kebab-case name the comment prompt points the agent at. Prefixed with the whole
 * package name: skill names share one flat namespace with no reverse-DNS scoping, so a
 * short name like `diff-comment` is the kind of thing another plugin would also pick. */
export const COMMENT_SKILL_NAME = 'dsh-diff-approval-comment'

/** Short routing line the skill catalog shows beside the name. */
export const COMMENT_SKILL_DESCRIPTION = 'How to answer a [评论] / [Review] comment on a few diff lines: '
  + 'answer those lines only, at most 3 lines, no blank line between them, and point at the message box '
  + 'below when three lines cannot carry the answer.'

/** Extra routing guidance for the catalog. */
export const COMMENT_SKILL_WHEN_TO_USE = 'A message that starts with `[评论] (path:lines)` '
  + '(or `[Review] (path:lines)` in English) is a comment from the diff panel — load this skill before answering it.'

/** The instruction body the agent loads, in the language its comments arrive in. */
export const COMMENT_SKILL_CONTENT = `# 回答代码批注

消息以 \`[评论] (path:lines)\` 开头时，就是 diff 面板里对那几行代码提的批注。按下面的规则回答：

- 只谈这几行（最多带上直接相邻的一两行），不要扩到整个文件或整个任务。
- 不超过 3 行。
- 行与行之间不要空行：讨论区按代码行排版，一个空行就占掉一整行高度，看起来像代码里的空洞。
- 要引用代码就写 \`文件:行号\`，不要把整段贴回来。
- 回答直接显示在批注下方的小讨论区里，所以不要写"如你所见""上面提到"这类指代。
- 不确定就说不确定，并说清需要看哪一段。
- 3 行里说不清（要展开、要看更多代码、要来回几轮），就直说一句"这条在批注里说不清，去下方发消息的输入框里聊"，不要在批注里硬塞长回答。
`

/** One runtime skill contribution, in the shape `ctx.skills.register` takes. */
export interface CommentSkillRegistration {
  /** Kebab-case identity the agent loads by. */
  readonly name: string
  /** Catalog routing line. */
  readonly description: string
  /** Catalog routing guidance. */
  readonly whenToUse: string
  /** Instruction body. */
  readonly content: string
  /** Origin bucket: this plugin contributes it at runtime, not from disk. */
  readonly source: 'runtime'
}

/** The contribution to register with the skill registry. */
export const COMMENT_SKILL: CommentSkillRegistration = {
  name: COMMENT_SKILL_NAME,
  description: COMMENT_SKILL_DESCRIPTION,
  whenToUse: COMMENT_SKILL_WHEN_TO_USE,
  content: COMMENT_SKILL_CONTENT,
  source: 'runtime',
}
