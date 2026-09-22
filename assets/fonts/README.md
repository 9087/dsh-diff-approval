# The bundled code font

The panel renders code and Chinese comments on one character grid, which needs a
font where one CJK glyph is exactly twice one Latin glyph. No system stack does
that on Windows or Android: the shell's own code font is
`"SF Mono", "JetBrains Mono", …, "PingFang SC", "Microsoft YaHei"`, so Latin
comes from a monospace face and hanzi from a proportional one, and every
Chinese comment drifts out of column.

So the font ships with the plugin. It is
[JetBrains Maple Mono](https://github.com/SpaceTimee/Fusion-JetBrainsMapleMono)
(JetBrains Mono for Latin, Maple Mono for CJK, fused upstream so the 2:1 ratio
holds by construction), subset into sliced woff2 files and served by the host.

## What is committed

| path | what it is |
| --- | --- |
| `ranked-hanzi.txt` | the 20,992 hanzi of U+4E00-9FFF in frequency order — the input the slice plan is built on |
| `regular-*.woff2`, `semibold-*.woff2` | the slices themselves (`regular-latin.woff2`, `regular-hanzi-000.woff2`, …) |
| `manifest.json` | every slice's `unicode-range`, byte size, weight, and the pinned upstream archive |
| `OFL.txt` | the font's licence, which must travel with it |

The full TTFs and the upstream archive are **not** committed: they are 17 MB and
141 MB, they are reproducible from the pinned URL and checksum in
`manifest.json`, and `scripts/fonts/build.py` fetches them into `vendor/`
(git-ignored) on demand. Keeping the whole font locally is still the point of
that cache — re-slicing must never require a network round trip, and after one
`--download` it does not.

## Rebuilding

```bash
python -m pip install fonttools brotli wordfreq jieba
python -m scripts.fonts.build --download --extract   # once: fills assets/fonts/vendor
python -m scripts.fonts.build                        # writes the slices + manifest
python -m scripts.fonts.build --check                # ranges cover U+4E00-9FFF exactly once
python -m scripts.fonts.build --plan                 # what a page actually pulls
```

`--download` verifies the archive's sha256 before unpacking, so a re-slice
cannot silently pick up a different font. `--check` is what CI-able confidence
looks like here: it re-reads the committed manifest, re-derives the covered
codepoints from every `unicode-range`, and fails on a gap, an overlap, or a byte
size that no longer matches the file on disk.

The frequency order is a separate, frozen input:

```bash
python -m scripts.fonts.rank --out assets/fonts/ranked-hanzi.txt   # regenerate (deliberate)
python -m scripts.fonts.rank --check assets/fonts/ranked-hanzi.txt # verify coverage
```

## Why the slices look like this

A browser downloads a whole `@font-face` slice as soon as **one** character in
its `unicode-range` appears on the page. Measured on this font:

- the whole hanzi block as one slice: **5,431,736 B** — one Chinese comment would
  cost 5.4 MB;
- four equal quarters by codepoint: **~5.8 MB total, and no better per page** —
  the 60 commonest hanzi are scattered across all four, because codepoint order
  has nothing to do with how often a character is used;
- frequency order plus a byte cap: a page using the commonest 200 hanzi pulls
  **one small slice** (the seed), a page using 3,000 pulls a few, and one rare
  character costs at most one capped slice (120 KB).

So the plan is a small seed slice (the 300 commonest hanzi) followed by slices
capped at 120,000 B each. Both numbers live in `scripts/fonts/build.py`; raising
the cap means fewer files, lowering it means a cheaper worst case. Changing
either re-slices the same frozen order, which is the point of committing it.

## What the CSS does with it

One rule in `src/client/code-font.ts`: `.lines{font-family:<the bundled family>, <the
shell's stack>}`. `.lines` is the diff's code table, so the grid lands on the code
and nothing else — comment bubbles, the file list and the panel's chrome keep the
shell's font stack.

**Off until asked for.** The switch is in the plugin's DSH Settings section
(`等宽 CJK 字体` / "Monospaced CJK font"), stored as `diff-approval:code-font`, and
it defaults to off because the slices are traffic the reader pays for: tens of
kilobytes for ordinary Chinese, at most ~120 KB per slice for a rare character,
33 KB for pure ASCII. Off means nothing is fetched at all — no manifest request,
no `@font-face` — so the default panel is exactly what it was before this
existed. A browser fetches a `@font-face` only when a rule uses it, which is what
keeps an enabled pure-ASCII file down to the one Latin slice.

`font-display: swap` rather than `block`: the code is readable in the system font
immediately, and swapping when the slices land changes the column width, never
the row height that the virtual window and the jump math are built on.

## Two things the font forces on the build

- **The full feature set is kept when slicing.** `pyftsubset`'s default prunes a
  code font down to `calt` and `locl` and drops GPOS entirely, which would take
  the slashed zero (`zero`), the character variants (`cv*`, `ss*`) and accent
  composition with it. `--layout-features='*'` costs ~20% on the Latin slice and
  is why `scripts/fonts/build.py` does not use the defaults.
- **The family name is our own** (`DSH Code Mono`), declared by
  `src/font-slices.ts`. Two reasons: the upstream name embeds the JetBrains
  trademark, which OFL does not grant rights to; and a separately installed copy
  of the upstream font would otherwise win over the webfont, silently replacing
  the slices the panel counts on. The copyright lines and the OFL text still
  travel with the files.

The face keeps its own `calt`, so `->` and `=>` draw as arrows — the same thing
JetBrains Mono already does everywhere else in the UI. The upstream project also
ships a no-ligature build (`…-NL-…`) if that ever changes; using it means
re-slicing, not a CSS override, because `calt` is what carries the arrows.

Unhinted on purpose: Windows browser rendering goes through DirectWrite, where
Google Fonts ships unhinted too, and dropping `cvt `/`fpgm`/`prep` makes every
slice smaller.

## Licence

SIL Open Font License 1.1, no Reserved Font Name declared by any of the three
copyright holders (JetBrains Mono, Maple Mono, and the fusion project), so
subsetting and redistribution are permitted provided `OFL.txt` and the
copyright notices travel with the files — which is why `OFL.txt` sits here.
`fontTools.subset` strips the license name records out of a woff2, so the file
is not optional: the slices do not carry the notice themselves.
