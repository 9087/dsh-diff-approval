# Changelog

## [0.7.0](https://github.com/9087/dsh-diff-approval/compare/v0.6.0...v0.7.0) (2026-08-20)

### Features

* add an in-file search bar to the code view, opened via a toolbar button or Ctrl+F. ([b53cf1e](https://github.com/9087/dsh-diff-approval/commit/b53cf1e2d87bc90da842318bf54140fee04d2189))
* anchor the per-block actions frame to the block's bottom edge and pad the diff bottom so it is never clipped. ([cf0ced7](https://github.com/9087/dsh-diff-approval/commit/cf0ced7966c24a3f81daf3ea6bc040ed788447a0))
* re-clicking the already-open file in the list jumps to the next diff block. ([699578e](https://github.com/9087/dsh-diff-approval/commit/699578e691499d368f06af6474db9686f84ada8e))
* show only the current session's diff files in the review panel. ([d4fd2dd](https://github.com/9087/dsh-diff-approval/commit/d4fd2dd80d42257361cdd37005d4becbe3fc14b7))
* show the hovered block's position among the file's diff blocks. ([0a02a19](https://github.com/9087/dsh-diff-approval/commit/0a02a190e024c86654d9ef36bbce9e1a15a7df60))

## [0.6.0](https://github.com/9087/dsh-diff-approval/compare/v0.5.0...v0.6.0) (2026-08-19)

### Features

* add per-block keep/revert via hover actions on each diff block. ([8ff56d4](https://github.com/9087/dsh-diff-approval/commit/8ff56d42de505aaf1501176f517c60587c7d3676))
* polish panel chrome and switch copied references to workspace-relative paths. ([9d87f06](https://github.com/9087/dsh-diff-approval/commit/9d87f06435e706aa444d3175b2367c926f395c55))

### Bug Fixes

* count only current-file line numbers in the copied line reference. ([b36e277](https://github.com/9087/dsh-diff-approval/commit/b36e277feab87c925818b4f96612696633c99c68))
* halve the overview ruler width so the scrollbar thumb stays visible. ([b80ef20](https://github.com/9087/dsh-diff-approval/commit/b80ef20609293b79fce7a0bbd9e1f7197afb5d1e))
* keep the default arrow cursor on the diff scrollbar. ([7982fa3](https://github.com/9087/dsh-diff-approval/commit/7982fa38b3311b48b77b27d38d2e1092e2df06f1))

## [0.5.0](https://github.com/9087/dsh-diff-approval/compare/v0.4.0...v0.5.0) (2026-08-18)

### Features

* add a fullscreen expand toggle that pins the panel to the window edge and persists. ([6a3d506](https://github.com/9087/dsh-diff-approval/commit/6a3d50617a41d6440e0d93f435bc0565920a778e))
* overlay changed-line markers on the diff scrollbar as an overview ruler. ([68e5c7a](https://github.com/9087/dsh-diff-approval/commit/68e5c7afb765e43a710292d13173d0af25b2c147))

### Bug Fixes

* align the pending-changes entry height with the live settings trigger. ([7f75685](https://github.com/9087/dsh-diff-approval/commit/7f756851aa3a733e255a85cf3e1ef9921fd30654))
* re-center the focused diff block on every jump even with a single block. ([a946644](https://github.com/9087/dsh-diff-approval/commit/a946644d9a88eb5148ee541a3961a0d10ebcf3d3))
* use a curated alphabetical grammar list in the highlight picker. ([369a12d](https://github.com/9087/dsh-diff-approval/commit/369a12db911633d3a1c65fdcfdd6e94635438b10))

### Performance Improvements

* cap highlight cost with line/time limits, whole-file degradation, and a tokenize cache. ([638aeba](https://github.com/9087/dsh-diff-approval/commit/638aeba82b434d417101e116719b4ee284ec31e4))
* virtualize the diff list to a viewport window and memoize rows. ([26bb6b4](https://github.com/9087/dsh-diff-approval/commit/26bb6b4e25bb5c42b5c42bcf5e8fff3de936af3a))

## [0.4.0](https://github.com/9087/dsh-diff-approval/compare/v0.3.0...v0.4.0) (2026-08-17)

### Features

* add a selection status bar with line-reference copy, Ctrl+L shortcut, and a highlight-language picker. ([2fd67eb](https://github.com/9087/dsh-diff-approval/commit/2fd67eb405429d52e33fbba4615e06342a3e2f55))
* keep the review panel clear of the composer seat and close it via outside click or a quiet header button. ([e73ad5f](https://github.com/9087/dsh-diff-approval/commit/e73ad5fe0e87e73b6fe9e5a0b4ce1d55f3667ba4))
* single-select file list with auto-advance, basename rows, and header open/reveal actions. ([c58f58e](https://github.com/9087/dsh-diff-approval/commit/c58f58e2813f2ec6d2b0581c83c37c380bdaebee))

### Bug Fixes

* hydrate pending changes at the workspace level so they survive a restart with a fresh session id. ([1bc6ff6](https://github.com/9087/dsh-diff-approval/commit/1bc6ff6c3d531fdc916438339fd0826cfa9e235b))

### Performance Improvements

* defer syntax highlighting a tick so selecting a file never blocks on tokenization. ([565caa2](https://github.com/9087/dsh-diff-approval/commit/565caa206ccbf710373981b6188dee4e1dd4b1e1))

## [0.3.0](https://github.com/9087/dsh-diff-approval/compare/v0.2.0...v0.3.0) (2026-08-16)

### Features

* capture str_replace_editor mutations through the fs intent seams. ([406165d](https://github.com/9087/dsh-diff-approval/commit/406165d618cc549120ea84f6a6f157b04696e52c))
* split the review panel with a resizable file list, adaptive geometry, and open/reveal actions. ([c1b237d](https://github.com/9087/dsh-diff-approval/commit/c1b237d50b984a959b513ed73226a5abc01aae72))

### Bug Fixes

* pin the npm registry and regenerate the lockfile for CI. ([9fc13c9](https://github.com/9087/dsh-diff-approval/commit/9fc13c9e1ed39ffe02a24e82ba4a6720b52936ed))

## 0.2.0 (2026-08-16)

### Features

* Add DeepSeek Harness pending-change review plugin: whole-file diff Keep/Revert, persistence, and dsh.bundle manifest. ([dd8c053](https://github.com/9087/dsh-diff-approval/commit/dd8c053b8814776a7e726a8f7d4b74957f663d81))

### Bug Fixes

* Render the pending-changes badge icon in collapsed sidebar mode. ([75f5db8](https://github.com/9087/dsh-diff-approval/commit/75f5db88e0e6ebb43cb78f211a5627e6765de624))
