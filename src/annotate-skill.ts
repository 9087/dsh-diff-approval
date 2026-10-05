/**
 * The skill that teaches the agent to annotate code with the panel's cards.
 *
 * The plugin offers two skills, and they are the two halves of one conversation. `-comment` is how to
 * ANSWER a card the reader wrote; this one is how to PLACE a card of the agent's own — for the moments
 * where the thing worth saying is "these lines, here" rather than a paragraph in the reply.
 *
 * Like the comment skill, the long form lives here rather than in the system prompt: the harness's
 * `skill` tool advertises the catalog (name, description, when-to-use) and loads the body on demand, so
 * a rule about annotating costs nothing until an agent is actually about to annotate.
 */

/** Kebab-case identity, prefixed with the package for the same flat-namespace reason as the comment skill. */
export const ANNOTATE_SKILL_NAME = 'dsh-diff-approval-annotate'

/** Short routing line the catalog shows beside the name. */
export const ANNOTATE_SKILL_DESCRIPTION = 'How to annotate code with the review panel\'s cards: one card '
  + 'per place, on the lines as the file reads now, never on lines a card already holds — and the card is '
  + 'a conversation the user can answer.'

/** Extra routing guidance for the catalog. */
export const ANNOTATE_SKILL_WHEN_TO_USE = 'The user asks you to explain, walk through, or review code '
  + 'that has pending changes in the review panel (查看差异 / 改动审批), or you want to point at particular '
  + 'lines while discussing them — load this before calling `diff_approval_annotate`.'

/** The instruction body the agent loads. */
export const ANNOTATE_SKILL_CONTENT = `# 用卡片给代码做批注

改动审批面板里的卡片 = 针对**具体几行代码**的对话。你写的批注会成为卡片的第一条内容（你在工具里写的 \`note\`），用户就在代码旁边看到它，并且可以在这张卡片里回你；他的回复会以 \`[评论] (path:lines)\` 的消息回到你。

## 什么时候该用

- 用户想读代码：把**调用链**一步步批注出来（每个关键调用点一张卡，按阅读顺序），比在回复里贴一大段代码或行号清单清楚得多。
- 你要指出某段代码的问题、理由、或需要注意的地方（Review 场景），让证据就贴在证据所在的行上。
- 你正在讨论某段代码，想把话直接挂在那些行上，而不是让用户在回复里对着行号找。

不要在用户没让你讲代码时刷卡片，也不要用它代替回复：卡片是**补充**，你的回答还是要写在回复里（可以简短说"已在代码上标了 3 处"并给出要点）。

## 怎么调用 \`diff_approval_annotate\`

- \`path\`：面板里那个文件。你读文件时用的路径也行（按尾部匹配）；匹配到多个会被拒，把完整路径给它。
  **文件还不在面板的列表里也没关系：会自动加进去**（工作区里能读成文本的文件），所以"用户想读懂某个文件"不必先等改动发生。工作区之外、或读不出文本，才会被拒。
- \`startLine\` / \`endLine\`：**现在**的行号（1 起，含两端；省略 \`endLine\` 就是一行）。先读文件再写号，别凭记忆。
- \`note\`：卡片上写的话。要短——卡片是**按行**排版、行高按行算的（上限 1000 字符，超了会被拒）。讲流程时，把这一步的序号写在 note 的**最前面**（\`1. …\`、\`2. …\`）。
- \`quote\`（可选，建议给）：你读到的那几行原文（换行连接）。文件在你读完之后又变了的话，会当场被拒并把现在的原文给你，避免批注挂在错误的行上。
- \`category\`（可选）：**给"一类批注"起一个 id**。同一类（同一轮、同一主题、同一次讲解）每次调用都传**同一个** id，换成另一类就换一个 id。面板会按这个 id 给评论列表里的那条评论画一个**彩色圆点**，所以**同一类的批注是同一个颜色**，两类之间可以靠颜色区分。**不传 \`category\` 就完全不画圆点**——它是可选的，圆点只为"有类别"的批注而画。
  - 颜色只有 12 种，id 是散列到颜色上的，所以**两个不同的 id 可能撞成同一个颜色**，那时这两类看起来一样：这不是"分了几类一目了然"，只是"同一类颜色一致"。想让人分得清，就**有意识地复用同一个 id**，不要给同一类换新 id。
  - id 本身不解析：随便给（uuid 也行）。颜色由它算出来；你写的 id 只出现在圆点的 **\`title\` / \`aria-label\`** 里（鼠标悬停、或读屏软件），**不是屏幕上的文字**。会去掉两端空白；最多 64 个字符，超了**截断**（不会因此拒掉整条批注）。

## 讲流程就在正文开头写序号

如果这几张卡是**一条流程/调用链的步骤**，把序号写在 note 的最前面，用户就能按号读：

- 序号没有专门参数，也不是面板画的——它就是正文的头几个字符，所以卡片里、列表里、复制出去的内容里都带着它，你在回复里也能引用同一个号。
- 号由你排：按你希望用户阅读的顺序；1、2、3… 连不连续、重不重复都随你（**不需要唯一**，讲同一个点的补充卡可以同号）。
- 顺序号也写进你的回复（"我在代码上标了 1–5，从 X 开始"），这样面板里的号和回复里的号对得上。
- 零散的批注（不是一串步骤）**不要**写号。

## 一张卡一个点

- 范围要小：**最多 60 行**，通常 1–5 行就够。要讲整段逻辑就拆成几张卡。
- 一条调用链 = 一张卡一个调用点，按你应该让用户阅读的顺序依次创建；不要把所有步骤塞进一张卡。
- note 里只谈这些行（最多带上直接相邻的一两行），不要扩到整个文件或整个任务。
- 写法沿用批注的规矩：不超过 3 行、行间不空行、**不要 Markdown 表格/列表/标题/围栏代码块**（卡片按行排版，表格会读成一堆竖线并把高度算错），行内只用 \`代码\` 和 **加粗**。要引用别处就写 \`文件:行号\`。
- 用用户的语言写 note。

## 那几行已经被占用时

如果这些行已经落在**某张卡片里**，调用会被拒，拒绝信息里会写明是哪一张（id、行号、它开头的话）。这不是错误，是"这里已经有话说了"：

- 换一处行号；或者
- 把这件事写进你的回复里，不要试图硬塞进那张卡：那张卡的对话属于写它的人（可能是用户，也可能是你早先写的）。如果用户想在那张卡上继续聊，他会在卡片里回复你，那时你会收到 \`[评论]\`，按 \`dsh-diff-approval-comment\` 的规矩回答即可。

**不要**在回复里假装已经批注成功——工具返回的是"refused: ..."就说明没有卡片被创建。
`

/** One runtime skill contribution, in the shape `ctx.skills.register` takes. */
export interface AnnotateSkillRegistration {
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
export const ANNOTATE_SKILL: AnnotateSkillRegistration = {
  name: ANNOTATE_SKILL_NAME,
  description: ANNOTATE_SKILL_DESCRIPTION,
  whenToUse: ANNOTATE_SKILL_WHEN_TO_USE,
  content: ANNOTATE_SKILL_CONTENT,
  source: 'runtime',
}
