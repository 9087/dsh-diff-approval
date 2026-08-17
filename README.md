# dsh-diff-approval

English | [中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/dsh-diff-approval)](https://www.npmjs.com/package/dsh-diff-approval)
[![CI](https://img.shields.io/github/actions/workflow/status/9087/dsh-diff-approval/ci.yml)](https://github.com/9087/dsh-diff-approval/actions)

A DeepSeek Harness (DSH) plugin for pending-change review: it automatically tracks every successful `edit`, `write`, and editor (`str_replace_editor`) mutation, folds all unhandled changes into one entry per file, and shows each file's diff with Keep/Revert in the sidebar — no git involved.

![Pending changes panel](docs/images/pending-panel.png)

## ✨ Features

- **Diff view**: syntax-highlighted diff with +/− counts and change-block jump (previous/next diff). Select text in the diff and the bottom status bar shows its `file:start-end` reference — click it (or press `Ctrl+L`) to copy.
- **Highlight language**: the diff's status bar picks the highlight language — auto-detected from the file extension (shown as "Auto: …"), or overridden manually from the dropdown.
- **Keep / Revert**: one decision per file. Keep accepts the changes; Revert writes the file back to its earliest basis (a created file is removed, a deleted tracked file is restored).
- **Open / Reveal**: open a file in its default app, or reveal it in the file manager, right from the diff header.
- **Persistence**: pending state is stored per workspace at `<dshHome>/diff-approval/workspaces/<workspaceId>.json` and survives restarts — unhandled changes are still there when you come back, even in a fresh session.

## 📦 Install

If `dsh` is on your `PATH`:

```sh
dsh plugin --profile web add dsh-diff-approval
```

Or, if you run the harness through npx (e.g. `npx @deepseek-ai/dsh web`):

```sh
npx @deepseek-ai/dsh plugin --profile web add dsh-diff-approval
```

or manually: add the package to your profile's `package.json` dependencies and insert this row into the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: diff-approval
      name: dsh-diff-approval
      # Optional: relocate durable pending state (defaults to
      # <dshHome>/diff-approval/workspaces).
      # config:
      #   storageDir: ~/dsh-pending
```

Then restart `dsh web`.

## 🚀 Usage

1. Work with the agent as usual — successful `edit` / `write` calls are recorded automatically.
2. Click the **Pending changes** action at the sidebar footer (the badge shows the count).
3. Click a file row to expand its full diff; use **Previous diff** / **Next diff** to jump between change blocks. Select text and click the reference in the bottom status bar (or press `Ctrl+L`) to copy a line reference.
4. **Keep** accepts the file's changes; **Revert** restores its earliest basis. The row then leaves the list.

## 📝 Notes

- Only tracked mutations (`edit`, `write`, and `str_replace_editor` editor calls) are recorded. Deletions made outside these tools (e.g. shell `rm`) are sensed only for tracked files: the entry turns "File is gone" and its Revert restores the file.
- Reverting a created file deletes it (the fs seam has no delete API).
- Sessions with no workspace keep their entries memory-only; corrupt persistence files are rejected and can be deleted to reset.

## 🛠 Development

```sh
corepack pnpm install
pnpm run typecheck   # tsc over both faces
pnpm run build       # emits lib/index.js and lib/client.js
pnpm test
```
