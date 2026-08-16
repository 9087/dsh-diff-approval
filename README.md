# dsh-diff-approval

English | [中文](README.zh.md)

A DeepSeek Harness (DSH) plugin for pending-change review: it automatically tracks every successful `edit` / `write` tool call, folds all unhandled changes into one entry per file, and shows each file's diff with Keep/Revert in the sidebar — no git involved.

## ✨ Features

- **Diff view**: syntax-highlighted diff with +/− counts, change-block jump (previous/next diff), and drag-to-copy line references.
- **Keep / Revert**: one decision per file. Keep accepts the changes; Revert writes the file back to its earliest basis (a created file is removed, a deleted tracked file is restored).
- **Persistence**: pending state is stored per workspace at `<dshHome>/diff-approval/workspaces/<workspaceId>.json` and survives restarts.

## 📦 Install

```sh
dsh plugin --profile web add dsh-diff-approval
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
3. Click a file row to expand its full diff; use **Previous diff** / **Next diff** to jump between change blocks.
4. **Keep** accepts the file's changes; **Revert** restores its earliest basis. The row then leaves the list.

## 📝 Notes

- Only `edit` and `write` are tracked. Deletions made outside these tools (e.g. shell `rm`) are sensed only for tracked files: the entry turns "File is gone" and its Revert restores the file.
- Reverting a created file deletes it (the fs seam has no delete API).
- Sessions with no workspace keep their entries memory-only; corrupt persistence files are rejected and can be deleted to reset.

## 🛠 Development

```sh
corepack pnpm install
pnpm run typecheck   # tsc over both faces
pnpm run build       # emits lib/index.js and lib/client.js
pnpm test
```
