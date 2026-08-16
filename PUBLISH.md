# Publishing workflow

`dsh-diff-approval` is published to npm (`dsh-diff-approval`) and hosted on
GitHub (`9087/dsh-diff-approval`). Releases are driven by `release-it` with
`@release-it/conventional-changelog`: the next version is computed from the
conventional-commit prefixes since the last tag, `CHANGELOG.md` is generated,
and CI publishes to npm automatically when a `v*` tag is pushed.

## Prerequisites

- Node 24 and pnpm 11.21 (see `packageManager` in `package.json`).
- Working tree clean; `pnpm run typecheck`, `pnpm test`, `pnpm run build` pass.
- Commit messages carry a conventional prefix (`feat:` / `fix:` / `perf:` /
  `chore:` / ...), are one-line English, and end with punctuation.
- npm is logged in as the package owner: `npm whoami --registry=https://registry.npmjs.org/`
  prints `9087_`. The machine's default registry is a mirror, so the official
  registry is always passed explicitly (the `release` config already pins it
  for publishing).

## Bump rules

- `feat:` → minor, `fix:` / `perf:` → patch, `feat!:` / `BREAKING CHANGE` →
  major, anything else does not advance the version.
- `0.x`: breaking changes may ride on a minor bump; `1.0.0` marks stability.
- Never reuse an already-published version.

## Standard release (happy path)

```powershell
npx release-it --ci --no-npm.publish
git push
git push --tags
```

- Step 1 bumps the version from the commit prefixes, writes `CHANGELOG.md`,
  commits `chore: release vX.Y.Z`, and tags `vX.Y.Z` — all locally, without
  publishing.
- Pushing the tag triggers `.github/workflows/release.yml`: it builds and runs
  `npm publish` with the `NPM_TOKEN` repository secret (a granular npm token
  with read/write on `dsh-diff-approval`, which bypasses the account 2FA), then
  creates a GitHub Release with generated release notes.

## If SSH to GitHub fails in the environment

Rewrite the SSH remote to HTTPS before pushing (requires the Windows
credential-manager login to GitHub):

```powershell
$env:GIT_CONFIG_COUNT='1'
$env:GIT_CONFIG_KEY_0='url.https://github.com/.insteadOf'
$env:GIT_CONFIG_VALUE_0='git@github.com:'
git push
```

## Manual publish fallback (without CI)

```powershell
npm publish --registry=https://registry.npmjs.org/
```

The npm account has 2FA on writes: npm prints a browser-auth URL or asks for
an OTP. The human must complete this step; the command runs `prepare` first
and publishes the built artifacts.

## Rules for agents

- Never commit or push without explicit user approval (repo convention).
- Never ask for, type, or transmit npm credentials or OTP values.
- Do not skip the `prepare` build; it is what ships `lib/`.
- If a release fails midway, release-it rolls back its working-tree changes on
  its own; any leftovers (e.g. `CHANGELOG.md`, `package.json` in `git status`)
  can be cleared with `git reset --hard HEAD`.
