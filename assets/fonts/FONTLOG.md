# FONTLOG

What the bundled font is, where it came from, and what was done to it. The
licence text is in `OFL.txt` next to this file; the machine-readable record of
the exact upstream build and every slice is in `manifest.json`.

## Upstream

- **JetBrains Maple Mono 1.2304.79** — <https://github.com/SpaceTimee/Fusion-JetBrainsMapleMono>
  - archive `JetBrainsMapleMono-XX-XX-XX-XX.zip`, sha256
    `1998cf7047be954c781510d5a651e9d57fadb2ee00bebd80a0719d49eaa50513`
  - the plain build: no Nerd Font icons (`XX`), no narrowed CJK (`XX` — that
    variant is documented as breaking the 2:1 ratio), no hinting (`XX`)
  - itself a fusion of **JetBrains Mono 2.304** (all non-CJK outlines) and
    **Maple Mono 7.9** (the CJK outlines), assembled by FontForge
  - CJK designs ultimately from Resource Han Rounded and Source Han Sans
- Licence of everything above: **SIL Open Font License 1.1**, with no Reserved
  Font Name declared by any of the three copyright holders. `OFL.txt` carries
  JetBrains Mono (2020), Maple Mono (2022) and Space Time (2025) notices.

## What this repository does to it

A **modification** in OFL terms, and therefore recorded here:

1. **Renamed** to `JetBrains Maple Mono for DSH` (the family the CSS declares).
   The name says which face it is; the `for DSH` marker keeps it from colliding
   with a copy of the upstream font the reader may have installed — a locally
   installed font wins over a webfont of the same name, which would leave these
   slices unused and render someone else's build. It also keeps the upstream
   names out of a user-visible primary name, which is what the OFL asks of a
   modified version (Maple Mono declares `Maple Mono` as a Reserved Font Name).
2. **Subset** to the characters a code diff can render: Latin and Latin-1,
   Latin Extended-A, general punctuation, arrows, box drawing, geometric shapes
   and dingbats, CJK punctuation and fullwidth forms, and the 20,992 hanzi of
   U+4E00-9FFF. Uncovered on purpose: Korean, CJK Ext-A/B, compatibility
   ideographs — those fall back to the system stack.
3. **Sliced** into woff2 files by frequency, so a page fetches the few hundred
   kilobytes it needs instead of the whole block. The order is frozen in
   `ranked-hanzi.txt`; the rule is in `scripts/fonts/build.py`.
4. **Converted** to woff2 and stripped of hinting (`--no-hinting`), keeping every
   OpenType feature (`--layout-features='*'`).

Both weights are cut from the same slices: Regular for code, SemiBold for
emphasis, matching `font-weight: 400` and `600`.

## Reproducing

```bash
python -m scripts.fonts.build --download --extract
python -m scripts.fonts.build
python -m scripts.fonts.build --check
```

`--download` verifies the sha256 above before unpacking, so the slices cannot
silently come from a different build of the font.
