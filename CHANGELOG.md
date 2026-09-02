# Changelog

## [0.15.0](https://github.com/9087/dsh-diff-approval/compare/v0.14.1...v0.15.0) (2026-09-02)

### Features

* intra-line word diff and similarity alignment in the split view ([4112aa7](https://github.com/9087/dsh-diff-approval/commit/4112aa74b0e6b5b1deb4b40ad4295f142f09f3c2))
* re-anchor diff-block navigation to the scroll position and make lead rows configurable ([9566714](https://github.com/9087/dsh-diff-approval/commit/9566714eaca4c5ff087ac196ad34a5315802af81))
* settings booleans use a toggle switch instead of a dropdown picker ([5255a25](https://github.com/9087/dsh-diff-approval/commit/5255a253057ead27a55137fe87ac1e18bc5d38d3))
* show the full diff path scrollable and drag-selectable ([5eff6c1](https://github.com/9087/dsh-diff-approval/commit/5eff6c1c9c89c9aad2eadbf295195d48adfe3738))

### Bug Fixes

* pin the per-block review frame to the diff viewport in single-column ([1dfe261](https://github.com/9087/dsh-diff-approval/commit/1dfe261ae179e81b7bc67597336a03406a2ff7e1))
* read large VCS blobs without the shell stdout cap ([155d775](https://github.com/9087/dsh-diff-approval/commit/155d77561228dccc701ecd3672f6fbf10ae792e4))
* strip auto-wrap's visual line breaks from copied diff text ([7ef2ddb](https://github.com/9087/dsh-diff-approval/commit/7ef2ddb0ed0ce4094ce71a660ab83b2c7c523d5e))

## [0.14.1](https://github.com/9087/dsh-diff-approval/compare/v0.14.0...v0.14.1) (2026-09-01)

### Bug Fixes

* keep selected diff rows mounted across scroll ([cc3e061](https://github.com/9087/dsh-diff-approval/commit/cc3e06102ee7d05512a52b67d63fd63d2266c878))
* keep the diff panel open when clicking the approval/permission card ([551b52f](https://github.com/9087/dsh-diff-approval/commit/551b52f6c9f2c2e44a36f4e416736f7cfca87cdd))
* throttle persistence writes to coalesce agent capture bursts ([08fb74c](https://github.com/9087/dsh-diff-approval/commit/08fb74c578121896f4b17a00669d7b1b86c898ef))

## [0.14.0](https://github.com/9087/dsh-diff-approval/compare/v0.13.1...v0.14.0) (2026-08-31)

### Bug Fixes

* keep the copy-reference selection when a drag lands on a line number ([0528410](https://github.com/9087/dsh-diff-approval/commit/05284102ecff7b39aaab4d939a4b4d0136e9712e))
* keep the entry removed after a whole-file keep (id must equal path) ([316fe41](https://github.com/9087/dsh-diff-approval/commit/316fe41525db94e5275524e54d1ba8db36603c8e))
* remap references against only the newest entry per path ([8f7ac56](https://github.com/9087/dsh-diff-approval/commit/8f7ac56c645ad3091655bfa7f669d2437a894f36))

## [0.13.1](https://github.com/9087/dsh-diff-approval/compare/v0.13.0...v0.13.1) (2026-08-31)

### Bug Fixes

* don't expire references on a trailing-newline-only drift ([e2b03b9](https://github.com/9087/dsh-diff-approval/commit/e2b03b9d3e3bb7ce6536468f5153a0592c9bcb5a))

## [0.13.0](https://github.com/9087/dsh-diff-approval/compare/v0.12.0...v0.13.0) (2026-08-30)

### Features

* auto-paste reference to composer without clipboard write or toast ([e77ff41](https://github.com/9087/dsh-diff-approval/commit/e77ff413841ffd24012f03c623cd0036ad14e3bc))
* cycle pending files with Ctrl+Tab / Ctrl+Shift+Tab ([b933950](https://github.com/9087/dsh-diff-approval/commit/b933950da7f337f21466ae2c13c3922cdedbe84c))
* keep fully-resolved files listed and prompt remove-or-keep ([ab5ff8f](https://github.com/9087/dsh-diff-approval/commit/ab5ff8f355d84b7570ab7b8e6d2cb6a8784bea70))
* keep/revert selected diff blocks via a selection frame ([cf8f893](https://github.com/9087/dsh-diff-approval/commit/cf8f8939dbb077c0561e766509dd5df85f048bf5))
* portal the diff panel out of the sidebar and align sidebar behavior ([fb0c8f5](https://github.com/9087/dsh-diff-approval/commit/fb0c8f5d4f466c4cd95261696903b29007859abb))
* quick-summon chord (Ctrl+D) toggles the review panel, Esc closes ([21d5493](https://github.com/9087/dsh-diff-approval/commit/21d54935971b5ca6c02049e5e0376dbc94d6d7c1))
* remap stale references in queued messages ([66dbd67](https://github.com/9087/dsh-diff-approval/commit/66dbd6751b0916d6a908f6cdaf5dcea474805ee5))
* wrap references in (path:line) and remap them as files change ([57bb1e1](https://github.com/9087/dsh-diff-approval/commit/57bb1e1c54a9d9b14a2f1191df955db07e4db2de))

### Bug Fixes

* disable mobile text autosizing in the diff view ([99c570d](https://github.com/9087/dsh-diff-approval/commit/99c570db2c50cb9ba5125bc085d901da6b8ebf62))
* preserve scroll position when the diff refreshes ([d5bdd45](https://github.com/9087/dsh-diff-approval/commit/d5bdd450cb1f5cd2d36fc3d6d6e4232dc47cd2dd))

## [0.12.0](https://github.com/9087/dsh-diff-approval/compare/v0.11.0...v0.12.0) (2026-08-28)

### Features

* add opt-in side-by-side split diff view ([9d5902e](https://github.com/9087/dsh-diff-approval/commit/9d5902ede08bfbb256269a58942f37c6ef2408e4))
* advance to the next diff block after a single-block keep/revert ([b5033c5](https://github.com/9087/dsh-diff-approval/commit/b5033c585c624e997c0eeaed86c73d598dfc2844))
* leave two rows of lead above the focused block in split view ([06d6960](https://github.com/9087/dsh-diff-approval/commit/06d696054f295596b3c4e6cc35c75dce74974d1d))
* per-side line references for split view selection (Ctrl+L) ([6d53d7e](https://github.com/9087/dsh-diff-approval/commit/6d53d7e21feabcf8378f7a9f6ea5c6f3bf36c09d))

### Bug Fixes

* make split-view block keep/revert clickable ([81bb54f](https://github.com/9087/dsh-diff-approval/commit/81bb54fb6c794633a6696ca3614fa85e5a134f2d))
* replay split-view block flash on every focus change ([56952ae](https://github.com/9087/dsh-diff-approval/commit/56952aefd9ef9087d2ca4cc2402bc6103ad13997))

## [0.11.0](https://github.com/9087/dsh-diff-approval/compare/v0.10.0...v0.11.0) (2026-08-27)

### Features

* stack multi-plugin sidebar footer actions, deferring to dsh-footer-order ([94e0542](https://github.com/9087/dsh-diff-approval/commit/94e05426578e72c32afd141067ceff9e9c762320))

### Bug Fixes

* normalize line endings and revert files to their current EOL ([38391bc](https://github.com/9087/dsh-diff-approval/commit/38391bcee2eb782af7b7f70b102ef5cc9bdebe40))

## [0.10.0](https://github.com/9087/dsh-diff-approval/compare/v0.9.0...v0.10.0) (2026-08-25)

### Features

* add per-language auto-wrap with precise VSCode-style wrapping ([6fabb82](https://github.com/9087/dsh-diff-approval/commit/6fabb8205bf5d260248b49066345886972063921))
* add prev/next diff buttons to the floating block actions frame ([a6f6d19](https://github.com/9087/dsh-diff-approval/commit/a6f6d19ae0b3be932176ba138daf928dd0bbd173))
* collapse the file list to a floating card constrained to the code scroll box ([e96a5b9](https://github.com/9087/dsh-diff-approval/commit/e96a5b979db177535fab3fbe852da5e9475f60f2))
* keep the floating file list open when picking a file ([4cdbde3](https://github.com/9087/dsh-diff-approval/commit/4cdbde3c8dd53715ece7c9229511ff7841efa128))
* order the pending file list by file name in the panel ([8b9bb98](https://github.com/9087/dsh-diff-approval/commit/8b9bb98e7cc36f111f1acedfd7e41f8d488f7bd1))
* wrap on a Unicode line-break model with configurable tab width ([b55e777](https://github.com/9087/dsh-diff-approval/commit/b55e77781c4f4cc305facbd1a03794f9299306e2))

### Bug Fixes

* keep the hovered block keep/revert frame inside the content bottom ([3b9fafd](https://github.com/9087/dsh-diff-approval/commit/3b9fafd6fd238f5c4bb7af5bd3f87a6371a74a85))

## [0.9.0](https://github.com/9087/dsh-diff-approval/compare/v0.8.0...v0.9.0) (2026-08-24)

### Features

* keep the pending panel open when every change has been handled ([f397d73](https://github.com/9087/dsh-diff-approval/commit/f397d73f17f1bd1a1ddaa38254a1008696165877))
* sense external file changes and fold them into undo/redo ([c5586f8](https://github.com/9087/dsh-diff-approval/commit/c5586f88b0c02234c8097542f5df5cf0d3d80af5))
* show the Ctrl+Up/Down block-jump shortcut in the prev/next diff tooltips ([4c2205d](https://github.com/9087/dsh-diff-approval/commit/4c2205d8c13ddf546349a6304a4816c54709acf0))

### Bug Fixes

* scroll long files to the first change block on open ([d5672b0](https://github.com/9087/dsh-diff-approval/commit/d5672b04df3aaad3bc5ffeeac6f45879183c5232))

## [0.8.0](https://github.com/9087/dsh-diff-approval/compare/v0.7.0...v0.8.0) (2026-08-23)

### Features

* add a panel settings button that opens the Diff Approval settings section, and turn the paste-on-copy preference into an Agent-preset-style On/Off picker. ([6a07724](https://github.com/9087/dsh-diff-approval/commit/6a07724ec0c658d7c2cf9e494a06859429ffd4fd))
* add Keep-all and Revert-all actions to the file list footer. ([0cafe8a](https://github.com/9087/dsh-diff-approval/commit/0cafe8aa3dc4e419a3b8d28c113900429b672ba4))
* adopt externally modified file content into the tracked baseline so the panel diff stays current. ([5ae07c1](https://github.com/9087/dsh-diff-approval/commit/5ae07c1acd1d02677e5d1672fc0b18c8eea3d41a))
* auto-paste a copied reference into the composer, toggled from a DSH Settings section. ([9b4c5f0](https://github.com/9087/dsh-diff-approval/commit/9b4c5f0eb861042933544810513ff0ed926c9419))
* import the workspace's local git/svn/p4 changes from the empty state, undoable as one action, with an opt-in untracked-files preference. ([c07ff5c](https://github.com/9087/dsh-diff-approval/commit/c07ff5c1c96e48628469a60e6ab4cefff9860a08))
* jump between diff blocks with Ctrl+Up/Down, make the diff body focusable, and flash the focused block on open and each switch. ([0bf4f6d](https://github.com/9087/dsh-diff-approval/commit/0bf4f6d77504ee7e3a195455d752aa699c4990ef))
* make keep/revert undoable with Ctrl+Z / Ctrl+Y, and unify the panel shortcuts as global window-capture chords. ([b10672f](https://github.com/9087/dsh-diff-approval/commit/b10672fd40326d6cfde4ed5dc960e289987c448c))
* make undo/redo focus the affected file and stay reachable after bulk actions with a close grace. ([2df3f29](https://github.com/9087/dsh-diff-approval/commit/2df3f29a879454e02f19744782a0442bd0beca4a))
* toast keep/revert failures, and keep the block flash inside the scroll viewport with a height clamp and ruler clearance. ([e56ccb6](https://github.com/9087/dsh-diff-approval/commit/e56ccb642376708033fb666ef156a86d4f42eedc))

### Bug Fixes

* fill the fullscreen diff panel seam with a sidebar-colored backdrop. ([09cac5d](https://github.com/9087/dsh-diff-approval/commit/09cac5df0b69ca21502f746103b8474d56f73af1))
* gray out the pending button while no reviewable session exists, including a freshly created blank one. ([18f8ec2](https://github.com/9087/dsh-diff-approval/commit/18f8ec29cd18a06733566fbb6e60d162e22c1599))
* keep the focused-block flash pinned to the diff viewport and settled before paint. ([cc4761b](https://github.com/9087/dsh-diff-approval/commit/cc4761be824599a39c086896a482bce416207cd3))
* keep the whole-file Keep/Revert buttons visually steady while busy, dropping the flashy processing state. ([1970106](https://github.com/9087/dsh-diff-approval/commit/197010627ac6accb00ac5c4b397d26eb0615ef94))
* match the footer pending button to the live settings trigger geometry (42px row, 2px outward margin). ([9727249](https://github.com/9087/dsh-diff-approval/commit/972724926fc3efb0ebb64e5bc64bb4d9de32ec0f))
* pass the per-session sandbox policy to revert writes and surface keep/revert failures inline instead of the full error screen. ([6ce69c6](https://github.com/9087/dsh-diff-approval/commit/6ce69c6d34e7262013b1c378c22ed6cf919fd8b0))

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
