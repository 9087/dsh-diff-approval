# Changelog

## [0.22.0](https://github.com/9087/dsh-diff-approval/compare/v0.21.0...v0.22.0) (2026-09-13)

### Features

* **panel:** remember the review's place, and never lose the panel ([6fa7b1f](https://github.com/9087/dsh-diff-approval/commit/6fa7b1f0d77a619039084c28d3f1bed204a0d380))

### Bug Fixes

* **panel:** keep the path bar scrollable without a bar in it ([d4e22fb](https://github.com/9087/dsh-diff-approval/commit/d4e22fb7035f99f03e9639af5c00850376030d81))

## [0.21.0](https://github.com/9087/dsh-diff-approval/compare/v0.20.1...v0.21.0) (2026-09-12)

### Features

* **panel:** advertise a button's chord wherever that button exists ([99d9930](https://github.com/9087/dsh-diff-approval/commit/99d99301d3d46145d2f000b983002e157d223af2))
* **panel:** drag the folded file list's width like the docked one ([f919bf0](https://github.com/9087/dsh-diff-approval/commit/f919bf0668941438857d64730eadf867c8dfe3ae))
* **panel:** float or dock the review panel, with per-edge coverage ([808a21e](https://github.com/9087/dsh-diff-approval/commit/808a21e463fc448d0db738df2d452ed785593e27))
* **panel:** open the review from the Session header, beside the app's controls ([98094d2](https://github.com/9087/dsh-diff-approval/commit/98094d24e136d3eefd23092ec706d1d0c168666c))
* **settings:** put the coverage switches in a group of their own ([9021d00](https://github.com/9087/dsh-diff-approval/commit/9021d00ef90f74eb530e5dc5b922e062b2cc6c66))

### Bug Fixes

* **panel:** keep the folded file list on the file view's box ([7329084](https://github.com/9087/dsh-diff-approval/commit/732908496ffb88128141a46be88ef19c96d24423))
* **panel:** never let the coverage insets squeeze the panel away ([a5bc485](https://github.com/9087/dsh-diff-approval/commit/a5bc485cf675605532052fde0e67894936334025))
* **settings:** hold the coverage switches in step with the panel ([fdf85bf](https://github.com/9087/dsh-diff-approval/commit/fdf85bf72fba85973edf5f9fee1b2426e25294e1))

## [0.20.1](https://github.com/9087/dsh-diff-approval/compare/v0.20.0...v0.20.1) (2026-09-12)

### Bug Fixes

* match the split view's horizontal scrollbar to the app's ([af109c4](https://github.com/9087/dsh-diff-approval/commit/af109c421382e709e525c8cd9286581e36bf4c17))
* stop declaring peer ranges that cannot admit prerelease builds ([6ad7ef4](https://github.com/9087/dsh-diff-approval/commit/6ad7ef44d548e68906005fa9d31d22e2caa62f12))

## [0.20.0](https://github.com/9087/dsh-diff-approval/compare/v0.19.3...v0.20.0) (2026-09-11)

### Features

* add a named file or directory to the pending list ([ceb18d6](https://github.com/9087/dsh-diff-approval/commit/ceb18d646ab4f684c35763a5c4afc75e962006ba))
* keep/revert Markdown preview change blocks ([bf9cb1a](https://github.com/9087/dsh-diff-approval/commit/bf9cb1a51da0205cc4d418b59d72d17ff616d94b))
* navigate the Markdown preview between change blocks ([b1eb37b](https://github.com/9087/dsh-diff-approval/commit/b1eb37ba9c6ffc244cf3c19d13afe572850577c7))
* remember the highlight language per file suffix ([9ec5f8a](https://github.com/9087/dsh-diff-approval/commit/9ec5f8a5b78897f59eeb725f1665e46cdda6531a))
* search the rendered Markdown preview ([be26730](https://github.com/9087/dsh-diff-approval/commit/be26730df50cd38eab498d6c3ecfeb9df6ff00bb))

### Bug Fixes

* align the settings spacing with the preference-row rhythm ([cce5ee4](https://github.com/9087/dsh-diff-approval/commit/cce5ee44ec5f3b886e69fd24a50464dbdb06e92e))
* gate the Markdown preview on the file being Markdown ([5d4f12c](https://github.com/9087/dsh-diff-approval/commit/5d4f12cc8236339191ad38c2c2ce97de6c4a3dbf))

### Performance Improvements

* highlight the diff a window at a time ([d8527d2](https://github.com/9087/dsh-diff-approval/commit/d8527d279e76a4b7de6c8af006e2b56efbf79695))

## [0.19.3](https://github.com/9087/dsh-diff-approval/compare/v0.19.2...v0.19.3) (2026-09-11)

### Features

* ask whether to remove a file after a whole-file keep/revert ([92cd1c9](https://github.com/9087/dsh-diff-approval/commit/92cd1c98104791a9e4b9a85a564d95e737007214))
* narrow the in-file search by case and whole word ([9ddc711](https://github.com/9087/dsh-diff-approval/commit/9ddc711c3a8c8baa228d2c9bfbb6f1526f2c1e1a))
* refresh one file's diff from the working tree ([9f267b6](https://github.com/9087/dsh-diff-approval/commit/9f267b60e792c604426ec42ec6cb2fb448374929))
* scope the search chords to the query box and unify Esc ([696f81a](https://github.com/9087/dsh-diff-approval/commit/696f81a4106a6dfcb00c078855c1a59ea0d5333b))
* scope the search narrowing chords to the bar and hint the chords ([9ba1ec2](https://github.com/9087/dsh-diff-approval/commit/9ba1ec2a3166c737c16954319ea8d0540ea5a229))

## [0.19.2](https://github.com/9087/dsh-diff-approval/compare/v0.19.1...v0.19.2) (2026-09-10)

### Bug Fixes

* mount the review channel when connection cannot resolve webServer ([0f4f530](https://github.com/9087/dsh-diff-approval/commit/0f4f53093c8c38790e411576d21c559d4dbbdf5d))

## [0.19.1](https://github.com/9087/dsh-diff-approval/compare/v0.19.0...v0.19.1) (2026-09-09)

### Bug Fixes

* copy the current file content, not the diff ([c35523f](https://github.com/9087/dsh-diff-approval/commit/c35523fd185c5fd32a62fec8aed0be9336a69cbc))
* match the fenced code-block background to the inline-code neutral gray ([b095fc0](https://github.com/9087/dsh-diff-approval/commit/b095fc01a08cd1c7596cdb555df2426e0dd0ef86))
* re-measure and re-center the source diff when leaving the Markdown preview ([0b92dd8](https://github.com/9087/dsh-diff-approval/commit/0b92dd8da484132870bb452701a5301b2ebc78ef))
* rename the source-view toggle to Switch to source in the Markdown preview ([da40a2b](https://github.com/9087/dsh-diff-approval/commit/da40a2ba505294d31caf56ae16b59b4276c35b9b))

## [0.19.0](https://github.com/9087/dsh-diff-approval/compare/v0.18.0...v0.19.0) (2026-09-08)

### Features

* bulk keep-all / revert-all as a single host call (one batch undo, no per-file churn) ([161909e](https://github.com/9087/dsh-diff-approval/commit/161909e072434a0870f7541ab60fcf4b7da7410e))
* gray placeholder block for Markdown preview images that cannot be inlined ([e0d53e4](https://github.com/9087/dsh-diff-approval/commit/e0d53e497123c846aec6fcf59d7656d6057cac66))
* limit Markdown preview content width to a configurable max (single=X, double=2X, default 800px) ([b671081](https://github.com/9087/dsh-diff-approval/commit/b671081521a8ab33ba6e74840bf2a5ff09f8f42b))
* markdown preview + word highlight + settings + icon ([d0bee7f](https://github.com/9087/dsh-diff-approval/commit/d0bee7f233de3db07f2755def4e952ade0facfbb))
* prompt remove-or-keep when a block keep/revert resolves the file's last change ([8be5419](https://github.com/9087/dsh-diff-approval/commit/8be54190fde81951f6b52598645c186ee64eaf17))
* quick-summon chord works even when focus is in an input or the composer ([5c9de9c](https://github.com/9087/dsh-diff-approval/commit/5c9de9c3a240b1fa3839e0c17edd39cb47f91ac4))

### Bug Fixes

* give each produced-file chip its own view-diff button ([9824c85](https://github.com/9087/dsh-diff-approval/commit/9824c8503bc139f6e15d707ef2697d638aef7a18))
* neutral-gray semi-transparent inline code chip in the Markdown preview ([fc373a1](https://github.com/9087/dsh-diff-approval/commit/fc373a16d7965c3dbeebf25fe98fea10f409eb25))
* remove a fully-resolved entry despite a line-ending-only difference (matches the diff view) ([d3cd1b9](https://github.com/9087/dsh-diff-approval/commit/d3cd1b9f18cfbb2fe3e4065f29b5c4dd8eea50c2))
* show the floating file list when the panel opens in Markdown preview ([75ba50f](https://github.com/9087/dsh-diff-approval/commit/75ba50feef63dbf627396b507e789e79be628e6a))
* suppress single-block toast on file open (re-click) ([172d418](https://github.com/9087/dsh-diff-approval/commit/172d418c513f2ef73b22328f1c4abac14ffc2e11))
* use the Markdown preview only for Markdown files ([963d71f](https://github.com/9087/dsh-diff-approval/commit/963d71ff43e214e4073d38515f1e00e387d35900))

## [0.18.0](https://github.com/9087/dsh-diff-approval/compare/v0.17.0...v0.18.0) (2026-09-07)

### Features

* diff-view customization with live preview and an HSV color picker ([27278f8](https://github.com/9087/dsh-diff-approval/commit/27278f87374ad3416d4b4390619068a51603fc6b))
* rename the keybindings settings group to Shortcuts and add a description ([a8c51c5](https://github.com/9087/dsh-diff-approval/commit/a8c51c5128f4dc2f02a39d4e37aca33c6aef87df))

### Bug Fixes

* hide the produced-file view-diff button when its chip is hidden ([21c890b](https://github.com/9087/dsh-diff-approval/commit/21c890bfb310d746941d9670ce4ba10da3cdd5d0))
* match produced-file chip path to pending path tolerantly (rel/abs, seps, case) ([03aa099](https://github.com/9087/dsh-diff-approval/commit/03aa099867622f3984ca947f3aa1958ccc23b0b1))
* prompt remove-or-keep on the last block and ride it on the keep/revert RPC ([6d6a8a4](https://github.com/9087/dsh-diff-approval/commit/6d6a8a4334a1af2b251d0a79e945f09983cdf67c))

## [0.17.0](https://github.com/9087/dsh-diff-approval/compare/v0.16.0...v0.17.0) (2026-09-06)

### Features

* add a view-diff action on produced files ([d0f58da](https://github.com/9087/dsh-diff-approval/commit/d0f58dae06ae7205fe0eb461bd8786c3d60db543))
* add diff search with word highlight, cursor-anchored start, and Esc layering ([17d3869](https://github.com/9087/dsh-diff-approval/commit/17d3869cd71a7d7bee805a7ea863f5cbbcdd51e1))
* add F3 / Shift+F3 search step and tooltips on the search buttons ([b39a624](https://github.com/9087/dsh-diff-approval/commit/b39a6241518d48e3fdf4ac1a12da42b0718092c4))
* expose a collapsed keybindings group in the settings ([d48b4f4](https://github.com/9087/dsh-diff-approval/commit/d48b4f499f69fd136748d479cae0604d3af20a9b))
* toast + shake the block at the keyboard wrap boundary ([e6a38f6](https://github.com/9087/dsh-diff-approval/commit/e6a38f61802ec40d2a962dc12ce53154f89be129))

### Bug Fixes

* append the copied reference to the composer draft instead of replacing it ([9005760](https://github.com/9087/dsh-diff-approval/commit/9005760c871d4dae67397da19a3be7cb2d6e74ad))
* apply the block-wrap boundary guard to toolbar and file re-click jumps ([abccbc9](https://github.com/9087/dsh-diff-approval/commit/abccbc9a8160ef3173afa7fb19acbdc65e342c8a))
* center the settings stepper +/− glyph and thin it ([129e313](https://github.com/9087/dsh-diff-approval/commit/129e313769e2bcd27c0261427ee961b085802ff4))
* clamp the current-block re-anchor at the scroller edges ([0e50138](https://github.com/9087/dsh-diff-approval/commit/0e501380bf69efd647f05490c37ecb49671bd8ae))
* clear the selection after a multi-block keep or revert ([c5e9986](https://github.com/9087/dsh-diff-approval/commit/c5e998629a9d1dd96e64b0650396dd5c8e2e0849))
* exclude diff line-number gutters from copied text ([016b483](https://github.com/9087/dsh-diff-approval/commit/016b4836f15e3118eff2e7a2317ce7cfc432779d))
* keep the copy-reference control out of the mobile file-guard heuristic ([914f989](https://github.com/9087/dsh-diff-approval/commit/914f989897964a22d70ffbef080d39f48e67f53f))
* normalize a change run to del-block then add-block ([9a37c9c](https://github.com/9087/dsh-diff-approval/commit/9a37c9cbccc199a782488d6497ef2c54167addc2))
* raise the block approval frame 2px so a slow hover doesn't drop it ([fd8f08f](https://github.com/9087/dsh-diff-approval/commit/fd8f08fe43e317872bee1a6eacb5967490c19c91))
* show copy-reference without wrapping parentheses in the status bar ([7ebc753](https://github.com/9087/dsh-diff-approval/commit/7ebc7532d44be0730b02e98d6da569fd773e43a7))
* show the single-column diff on switching back from split view ([9905763](https://github.com/9087/dsh-diff-approval/commit/9905763114b712e2229ec86d624f488b11f7a014))
* surface the just-resolved remove prompt reliably and consume its latch ([b018bab](https://github.com/9087/dsh-diff-approval/commit/b018bab90a6441b33750d4f4b22ec5c662035f39))
* unify the split approval frame step with the single-column wrap ([2f3290b](https://github.com/9087/dsh-diff-approval/commit/2f3290bc287b59b2d9751a14d7c750993a5027e3))

### Performance Improvements

* make the whole-file diff fast on large edited files ([3490c25](https://github.com/9087/dsh-diff-approval/commit/3490c25b09c7cc0d0137707fce6ef5505268d33a))

## [0.16.0](https://github.com/9087/dsh-diff-approval/compare/v0.15.0...v0.16.0) (2026-09-03)

### Features

* toggle the diff view between unified and side-by-side from the toolbar ([cd38252](https://github.com/9087/dsh-diff-approval/commit/cd38252d7d47a1348e7037568df4f41dc5c57c89))

### Bug Fixes

* read large VCS baseline blobs via git show with a per-command stdout budget ([75b6f91](https://github.com/9087/dsh-diff-approval/commit/75b6f91c4fbc57c65de9a5e0f16a66ab189867f5))
* surface the block approval frame on every pair of a similarity-aligned block ([6b8e83e](https://github.com/9087/dsh-diff-approval/commit/6b8e83ecfc140b95f282480f3dc59fc831178f7d))

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
