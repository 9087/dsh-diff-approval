# dsh-diff-approval

[English](README.md) | 中文

[![npm 版本](https://img.shields.io/npm/v/dsh-diff-approval)](https://www.npmjs.com/package/dsh-diff-approval)
[![CI](https://img.shields.io/github/actions/workflow/status/9087/dsh-diff-approval/ci.yml)](https://github.com/9087/dsh-diff-approval/actions)

一个 DeepSeek Harness（DSH）待处理改动审核插件：自动跟踪每次成功的 `edit` / `write` / 编辑器（`str_replace_editor`）改动，在侧边栏整合为一个待处理列表，可逐个文件查看完整差异并保留 / 回退，也可以把工作区里版本控制仓库的本地改动一键导入（Git / SVN / Perforce）。

![待处理改动面板](docs/images/pending-panel.zh.png)

面板还可把文件列表折叠成浮动卡片；浮窗形态下可以逐边选择覆盖左侧边栏、右侧边栏与下方输入框（三者全开就是原来的全屏），也可以停靠到右侧边栏、成为其中一个标签页：

| 折叠的文件列表 | 覆盖全部 |
| --- | --- |
| ![折叠的文件列表](docs/images/file-list-collapsed.zh.png) | ![覆盖全部](docs/images/fullscreen.zh.png) |

对 Markdown 文件，还可把源码行差异切换为渲染后的「改前 / 改后」预览：

![Markdown 预览](docs/images/markdown.zh.png)

## ✨ 功能

- **差异视图**：语法高亮整文件差异与 +/− 统计，滚动条上有概览标尺标示改动位置，支持文件内搜索（`Ctrl+F`，用 `F3` / `Shift+F3` 步进，并高亮匹配词）。列表按视口虚拟化渲染，大文件也能保持流畅。
- **差异块导航与操作**：用 `Ctrl+↑/↓`（或上一处 / 下一处按钮）在差异块间跳转，当前块会高亮闪烁，导航以当前滚动位置为锚点并在首尾循环。悬停某一块可从小操作框单独**保留 / 回退**该块，并显示其位置（如「2/5」）；处理完一块后会自动跳到下一块。跳转目标上方保留的行数可在设置中配置。
- **选区操作框**：拖动选中一段行，会浮现**保留 / 回退**该段行的操作框。
- **整文件与批量操作**：文件列表里的文件可逐个保留 / 回退，也可在列表底部**全部保留** / **全部回退**。
- **已处理文件保留在列表**：某文件的改动全部处理完后，条目仍保留在列表中，面板会询问是移除还是继续保留。
- **撤销 / 重做**：每次保留、回退、导入都可以用 `Ctrl+Z` / `Ctrl+Shift+Z` 撤销 / 重做（可在「快捷键」中重绑，`Ctrl+Y` 仍作为别名），面板打开期间全局生效，输入框保留各自的编辑行为。
- **快速呼出与文件切换**：`Ctrl+D`（可在设置中修改）在任意位置开关面板，`Esc` 关闭；`Ctrl+Tab` / `Ctrl+Shift+Tab` 在待处理文件间切换。
- **行引用**：选中 diff 文本后，底部状态栏显示其 `(文件:行号)` / `(文件:起-止)` 引用——点击（或按 `Ctrl+L`）即可复制，开启设置后还会自动粘贴到消息输入框并获得焦点。消息输入框和排队消息里的引用会随文件改动**自动对齐**：存活的行映射到新行号，整段被删的行变成 `(文件:LINE_MISSING)`。
- **高亮语言**：默认按扩展名自动检测，也可通过下拉列表手动切换。
- **自动换行**：语言下拉旁有个「Wrap lines / 自动换行」开关，按语言记住；CJK 逐字断行、拉丁词保持完整。
- **双栏对比**：可选的双栏视图（左「改前」｜右「当前」），逐行对齐，两侧各自横向滚动、共享纵向滚动条。可在工具栏或设置中切换，默认是单栏（合并）视图。双栏视图按内容相似度对齐改动块，并对改动行做词级差异高亮——拉丁文字按整词、CJK 逐字。
- **Markdown 预览**：对 Markdown 文件可在「源码」行差异与渲染后的「改前 / 改后」预览之间切换。预览内容最大宽度可配置。
- **外观自定义**：在「差异视图」设置组里可调整差异代码字号（%）、行高（px）以及新增 / 删除行颜色，并带实时预览。
- **外部改动**：已纳入列表的文件若之后被外部修改（其它工具 / 编辑器），面板会跟进最新内容并标记分歧。
- **打开 / 定位**：查看某个文件的差异时，可一键在默认应用中打开它，或在系统文件管理器中定位它。
- **导入工作区改动**：列表为空时，点击按钮即可导入工作区里 **Git / SVN / Perforce** 的本地改动——已修改、已删除，以及（可选开启的）未跟踪文件。通过从工作区目录逐级向上查找 VCS 根目录，工作区在子目录里也能识别。
- **设置**：在 DeepSeek Harness 设置里新增「改动审批」页，分为「差异视图」（代码字号、行高、新增 / 删除颜色）与「快捷键」（重绑面板各类按键组合）两组，另有复制后自动粘贴、导入时是否包含未跟踪文件、diff 的 Tab 宽度（2 / 4 / 8 空格）、双栏对比开关、差异跳转行距、Markdown 预览默认与宽度，以及快速呼出快捷键。
- **持久化**：待处理状态按 workspace 落盘至 `<dshHome>/diff-approval/workspaces/<workspaceId>.json`，跨重启保留——回来时未处理的改动仍在，即便换了新会话。

## 📦 安装

若 `dsh` 已在 `PATH` 中：

```sh
dsh plugin --profile web add dsh-diff-approval
```

若通过 npx 启动 harness（如 `npx @deepseek-ai/dsh web`）：

```sh
npx @deepseek-ai/dsh plugin --profile web add dsh-diff-approval
```

或手动：把本包加入 profile 的 `package.json` 依赖，并在该 profile 的 `cordis.patch.yml` 中加入：

```yaml
- insert:
    - id: diff-approval
      name: dsh-diff-approval
      # 可选：把落盘位置迁到别处（默认是
      # <dshHome>/diff-approval/workspaces）。
      # config:
      #   storageDir: ~/dsh-pending
```

然后重启 `dsh web`。

## 🚀 用法

1. 照常和 agent 对话——成功的 `edit` / `write` / 编辑器（`str_replace_editor`）调用会自动记录。
2. 点击侧边栏底部的 **待处理改动** 入口，逐文件查看差异并 **保留 / 回退**。
3. 列表为空时，点 **导入工作区改动**，把工作区的 Git / SVN / Perforce 本地改动拉入。

## 📝 注意事项

- 只自动记录被跟踪的改动（`edit`、`write` 与编辑器 `str_replace_editor` 调用）。通过以上工具以外的删除（如 shell `rm`）只能对已跟踪的文件感知：条目显示"文件已不存在"，回退即恢复。
- VCS 导入通过部署环境的 shell 执行器运行只读的 Git / SVN / Perforce 命令，需要对应 CLI 在 `PATH` 中。导入未跟踪文件（默认关闭）会扫描整个工作区，目录很大时可能较慢。
- 新建文件的整文件回退操作显示为**删除**并移除该文件。
- 回退文件时会保留其当前换行符（LF / CRLF）。
- 没有 workspace 的会话条目仅存内存；损坏的落盘文件会被拒绝，删除即可重置。
- 侧边栏底部入口会与其他插件的入口纵向排列，并在存在专门的 dsh-footer-order 插件时交由它统一管理。

## 🛠 开发

```sh
corepack pnpm install
pnpm run typecheck   # 两个编译面的 tsc
pnpm run build       # 产出 lib/index.js 与 lib/client.js
pnpm test
```
