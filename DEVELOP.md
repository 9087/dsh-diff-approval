# Development

How this plugin is built, how to run it while working on it, and what a checkout has to do that an installed
package does not. For shipping it, see [`PUBLISH.md`](PUBLISH.md).

## What the plugin is made of

Two halves, two bundles, one package:

| half | source | bundle | runs in |
| --- | --- | --- | --- |
| host | `src/*.ts` (`src/index.ts` is the entry) | `lib/index.js` | the DSH host process (Node) |
| client | `src/client/*` (React, `src/client/index.ts`) | `lib/client.js` | the browser, inside the shell's pages |

They talk over the plugin's own channel (`diff-approval`), which is why almost every feature has a host side
(the store, the VCS work, the comment records, the update probe) and a client side (the panel). `pnpm run build`
builds both: `tsc -b tsconfig.json` (types and the host face) plus `tsdown --env.DSH_BUILD_FACE client`.

## Prerequisites

- Node 24 and pnpm 11.21 (`packageManager` in `package.json`).
- Python 3 for the font pipeline (`scripts/fonts`), and a Playwright browser install for the e2e suite.

```sh
corepack pnpm install
npx playwright install chromium   # once, for pnpm run e2e
```

## Commands

```sh
pnpm run typecheck   # tsc over both faces
pnpm run build       # emits lib/index.js and lib/client.js
pnpm test            # the unit suite (vitest)
pnpm run e2e         # the browser suite (Playwright, against a real host)
pnpm run screenshots # regenerate the README figures from a real browser (opt-in, see below)
pnpm run compat      # the compatibility matrix: this checkout against the supported DSH releases
pnpm run compat:newer # …and against published releases newer than the latest
pnpm run verify:release # after a release is pushed: did the tag's commit pass CI, and did npm get that version
pnpm run fonts:check # the bundled code font: 138 slices, every range covered exactly once
pnpm run fonts:plan  # what a page actually downloads, by how many hanzi it shows
```

The build is also a CI gate in its own right: after `pnpm run build`, `node scripts/check-reproducible-build.mjs`
builds again and compares the bytes, so the bundle has to be a function of the source (see `build/css-class-map.ts`
for the CSS-module mapping that made it so). There is no script alias for that check — it is one command.

## README screenshots

`README.md` and `README.zh.md` embed four figures per language, under these names: `floating-panel`,
`docked-sidebar`, `markdown-preview` and `comment-card`. The docked pair use a right sidebar widened to about two
thirds of the window; the Markdown preview is captured in that sidebar's fullscreen mode. They are generated, not
drawn by hand:

```sh
pnpm run build       # the screenshot host serves lib/, not src/
pnpm run screenshots # needs `dsh` on PATH, or DSH_BIN
```

`pnpm run screenshots` runs `e2e/screenshots.spec.ts` with `README_SHOTS=1` (a plain `pnpm run e2e` skips that
spec, so ordinary test runs never rewrite committed images). The spec boots throwaway `dsh web` hosts against a
temporary `DSH_HOME`, seeds a believable six-file project (an HTML page, its JS/CSS, a README whose heading,
table and list changed, a changelog and a route list) and captures both languages: the host is restarted with
`locale.preference` set and each browser context uses a matching locale, so the shell and the panel's labels
agree. English writes `docs/images/name.png`, Chinese `docs/images/name.zh.png`. It also rewrites
`screenshots.json`, the manifest of the committed figures.

The conversation in the docked figures cannot come from a model (the suite has no key), so each host is booted with
`--patch e2e/fixtures/profile.patch.yml`: that mounts `e2e/fixtures/seed-screenshot-session.mjs`, a fixture plugin
that publishes ONE live session carrying a finished user prompt and a finished assistant reply. Its
`e2e/fixtures/package.json` gives the fixture its own package root, so the loader does not see two
`dsh-diff-approval` packages.

The seeded project is `C:\PROJECTS\dsh-homepage` (removed again by the spec), so the path the panel header shows
in the figures reads like a real checkout. The throwaway home stays in gitignored `scratch/readme-fixture`.

## The loop while working

- **Client change**: `pnpm run build`, then reload the page (`Ctrl+F5`). The client bundle is watched by the shell,
  so a refresh is enough.
- **Host change**: `pnpm run build`, then restart `dsh web`. The host loads `lib/index.js` once, at start-up;
  nothing reloads it for you.
- **Anything the e2e suite drives**: build first. `pnpm run e2e` drives the built `lib/`, not the source.
- The unit suite reads source directly, so it needs no build.

## A checkout says more than an installed package

A `file:` profile install materialises the package as hard links to this checkout, so a rebuild is picked up where
the host looks. What it does NOT pick up is a file the package's `files` list did not name *at install time*:

```sh
npx @deepseek-ai/dsh plugin --profile web install   # then restart `dsh web`
```

That is the refresh to run when `files`, or the set of assets the plugin serves, has grown. Editing a file that was
hard-linked during an install breaks the link for that one file, so a profile copy can go stale on its own; the
reinstall above is also the cure for that.

## The bundled font

The panel ships [JetBrains Maple Mono](https://github.com/SpaceTimee/Fusion-JetBrainsMapleMono) (SIL OFL 1.1),
subset and sliced by `scripts/fonts` so a page downloads only the code points it shows. The pipeline, the licence
and what each slice costs are documented in [`assets/fonts/README.md`](assets/fonts/README.md);
`pnpm run fonts:check` verifies the slices and `pnpm run fonts:plan` reports a page's real download.
