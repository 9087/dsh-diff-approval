# Publishing workflow

`dsh-diff-approval` is published to npm (`dsh-diff-approval`) and hosted on GitHub
(`9087/dsh-diff-approval`). This file is the whole story of a release: what the one local command does, what
the pushed tag starts on GitHub, and what to check afterwards.

## One command

```sh
pnpm run release          # release-it, then node scripts/verify-release.mjs
```

`.release-it.json` decides what that does:

- **`before:bump` runs `pnpm run build && pnpm test && pnpm run compat`.** A red unit suite or a red
  compatibility matrix stops the release BEFORE the version is bumped, so a failing build never gets a tag.
  Note what is NOT in that hook: the browser suite (`pnpm run e2e`) is in neither the hook nor the workflow
  below — run it by hand before releasing a behaviour change.
- The next version comes from the conventional-commit prefixes since the last tag
  (`@release-it/conventional-changelog`): `feat:` → minor, `fix:` / `perf:` → patch, `feat!:` /
  `BREAKING CHANGE` → major, and anything else does not advance the version. On `0.x`, a breaking change may
  ride a minor bump.
- `CHANGELOG.md` is generated, never hand-written.
- It commits `chore: release vX.Y.Z`, tags `vX.Y.Z`, and **pushes both** (`"git": { "push": true }`), so
  there is no separate `git push` / `git push --tags` step.
- It does **not** publish to npm (`"npm": { "publish": false }`). Publishing is CI's job, below.

This runs on a clean working tree; the hook is the gate, so a release cannot start from a tree that fails it.

## What the tag starts (GitHub Actions)

`.github/workflows/release.yml` runs on `push: tags: ['v*']`:

1. the **compatibility matrix** (`compat.yml`, called as a job) — every published release inside the declared
   peer range has to mount this build;
2. `pnpm test` and `pnpm run build` on the tagged commit;
3. `npm publish --provenance`, authenticated by **npm Trusted Publishing** (OIDC for
   `github.com/9087/dsh-diff-approval` + `.github/workflows/release.yml`) — there is no long-lived npm token
   anywhere;
4. a GitHub Release with generated notes.

A red matrix fails the job, and `publish` cannot start without it.

## Afterwards

```sh
pnpm run verify:release
```

`scripts/verify-release.mjs` checks the two things the local command cannot see: that the tagged commit passed
the workflows on GitHub, and that the registry really received the version the tag names. A manual spot check
is the same fact from one place:

```sh
npm view dsh-diff-approval@X.Y.Z gitHead   # must equal the release commit
```

## Prerequisites

- Node 24 and pnpm 11.21 (see `packageManager` in `package.json`).
- One-line English conventional-commit subjects ending with punctuation.
- The repo `.npmrc` pins the official registry (the machine default is a mirror), so resolution and publishing
  both use npmjs.

## If pushing fails in this environment

The remote is HTTPS (`https://github.com/9087/dsh-diff-approval.git`) and the Windows credential manager
supplies the token. An environment that only offers SSH, and whose SSH fails, can rewrite the remote for one
push:

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

Requires a local `npm login` as the package owner. The account has 2FA on writes: npm prints a browser-auth URL
or asks for an OTP, and the human completes that step. `prepare` builds `lib/` first. Prefer the CI path — a
manual publish skips the provenance attestation.

## Rules for agents

- Never commit or push without the user's explicit approval (repo convention).
- Never ask for, type, or transmit npm credentials or OTP values.
- Do not skip the `prepare` build; it is what ships `lib/`.
- If a release fails midway, `release-it` rolls its own working-tree changes back; check `git status`, and clear
  anything left over with `git reset --hard HEAD`.
- Bump rules, in one line: `feat:` minor, `fix:` / `perf:` patch, breaking major; never reuse a published
  version.
