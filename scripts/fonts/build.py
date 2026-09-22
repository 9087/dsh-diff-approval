"""Slice the bundled code font into woff2 files a page can pull on demand.

The problem this solves: a CJK-capable code font carries ~21,000 hanzi, and a
browser downloads a whole `@font-face` slice as soon as one character in its
`unicode-range` appears. One file for the whole block therefore means ~5 MB for
a single Chinese comment, and a plain four-way split still means megabytes,
because codepoint order has nothing to do with how often a character is used.

So the hanzi are ordered by frequency (`scripts/fonts/rank.py`, frozen in
`assets/fonts/ranked-hanzi.txt`) and cut into small slices with a byte cap.
A page that uses common characters pulls one or two small files; a genuinely
rare character costs one capped file and never the whole font. Latin, the two
punctuation blocks and the box/arrow block are fixed slices.

Everything here is deterministic: the same inputs produce byte-identical
slices, and `--check` re-verifies the whole plan without touching the network.

Usage:
  python -m scripts.fonts.build --download          # fetch + verify the upstream archive
  python -m scripts.fonts.build --extract           # unpack the TTFs from the archive
  python -m scripts.fonts.build                     # slice every face into assets/fonts
  python -m scripts.fonts.build --check             # verify the committed slices
  python -m scripts.fonts.build --plan              # show what a page would pull
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile

# --- pinned upstream -------------------------------------------------------
# The fused typeface: JetBrains Mono (Latin) + Maple Mono (CJK), built so one CJK
# glyph is exactly twice one Latin glyph. License: SIL OFL 1.1, no Reserved Font
# Name declared by any of the three copyright holders, so a subset may be
# redistributed; see assets/fonts/OFL.txt.
RELEASE = '1.2304.79'
ARCHIVE = 'JetBrainsMapleMono-XX-XX-XX-XX.zip'  # XX = no Nerd icons, no narrow CJK, no hinting
ARCHIVE_URL = (
    'https://github.com/SpaceTimee/Fusion-JetBrainsMapleMono/releases/download/'
    '%s/%s' % (RELEASE, ARCHIVE)
)
ARCHIVE_BYTES = 141000088
ARCHIVE_SHA256 = '1998cf7047be954c781510d5a651e9d57fadb2ee00bebd80a0719d49eaa50513'

# --- layout ----------------------------------------------------------------
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FONTS = os.path.join(ROOT, 'assets', 'fonts')
VENDOR = os.path.join(FONTS, 'vendor')
RANKED = os.path.join(FONTS, 'ranked-hanzi.txt')
MANIFEST = os.path.join(FONTS, 'manifest.json')

# Faces to slice. The family name is the font's own; the declared weight is what
# the panel's CSS asks for (`font-weight: 400` for code, `600` for emphasis).
FACES = [
    {'face': 'regular', 'file': 'JetBrainsMapleMono-Regular.ttf', 'weight': 400},
    {'face': 'semibold', 'file': 'JetBrainsMapleMono-SemiBold.ttf', 'weight': 600},
]

# The fixed slices. Latin first so a pure-ASCII page costs one small file; the
# dash/space block carries the em dash, the ellipsis and the non-breaking space.
FIXED = [
    ('latin', 'U+0020-007E,U+00A0-00FF,U+0100-017F'),
    ('punctuation', 'U+2000-206F'),
    ('symbols', 'U+2190-21FF,U+2500-257F,U+25A0-25FF,U+2700-27BF'),
    ('cjk-punctuation', 'U+3000-303F,U+FF00-FFEF'),
]

# Hanzi slicing. The first slice is small so a typical Chinese comment pulls tens
# of kilobytes rather than a hundred; every later slice is capped, so a rare
# character costs at most one cap. Both numbers are byte budgets for the
# compressed woff2, chosen from the measured plan (`--plan`).
SEED_GLYPHS = 300
CAP_BYTES = 120000
# `--layout-features='*'` on purpose. pyftsubset's default prunes a code font
# down to `calt` and `locl` and drops GPOS entirely, which would take the
# slashed zero (`zero`), the character variants (`cv*`, `ss*`) and the accent
# composition with it. The features whose input glyphs are not in a slice are
# pruned anyway, so the cost is bounded: ~20% on the Latin slice.
SUBSET_ARGS = ['--flavor=woff2', '--layout-features=*', '--no-hinting']

# Set by `--log`: the slice build runs for minutes, and a shell pipe buffers its
# output, so a watcher outside the process needs a file it can tail.
LOG_FILE: str | None = None

def log(message: str) -> None:
    """Progress goes to stderr and, when asked, to a file.

    `--log <path>` exists because this build runs for minutes: piping its output
    through a shell buffers it, so a watcher outside the process needs a file it
    can tail.
    """
    print(message, file=sys.stderr, flush=True)
    if LOG_FILE is not None:
        with open(LOG_FILE, 'a', encoding='utf-8') as handle:
            handle.write(message + '\n')


def sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def cache_path() -> str:
    return os.path.join(VENDOR, ARCHIVE)


def local_mirrors() -> list[str]:
    """Copies of the pinned archive other steps may have left behind."""
    return [os.path.join(ROOT, '.tmp-fontprobe', 'jbm', ARCHIVE)]


def verified(path: str) -> bool:
    """Whether `path` is the pinned archive, hash-checked once per file."""
    stamp = path + '.sha256'
    if os.path.exists(stamp):
        try:
            with open(stamp, encoding='utf-8') as handle:
                if handle.read().strip() == ARCHIVE_SHA256 and os.path.getsize(path) == ARCHIVE_BYTES:
                    return True
        except OSError:
            pass
    if os.path.getsize(path) != ARCHIVE_BYTES:
        return False
    if sha256(path) != ARCHIVE_SHA256:
        return False
    with open(stamp, 'w', encoding='utf-8') as handle:
        handle.write(ARCHIVE_SHA256)
    return True


def download(force: bool = False) -> str:
    os.makedirs(VENDOR, exist_ok=True)
    target = cache_path()
    if os.path.exists(target) and not force and verified(target):
        log('archive already cached and verified: %s' % target)
        return target
    # A mirror beats a fresh download: the fused archive is 141 MB and a build
    # step has usually fetched it already.
    for mirror in local_mirrors():
        if os.path.exists(mirror) and verified(mirror):
            log('using the archive already downloaded at %s' % mirror)
            shutil.copyfile(mirror, target)
            return target
    log('downloading %s (%.1f MB)' % (ARCHIVE_URL, ARCHIVE_BYTES / 1e6))
    partial = target + '.part'
    with urllib.request.urlopen(ARCHIVE_URL, timeout=600) as response, open(partial, 'wb') as out:
        shutil.copyfileobj(response, out, 1 << 20)
    digest = sha256(partial)
    if digest != ARCHIVE_SHA256:
        os.remove(partial)
        raise SystemExit('checksum mismatch: got %s, expected %s' % (digest, ARCHIVE_SHA256))
    os.replace(partial, target)
    with open(target + '.sha256', 'w', encoding='utf-8') as handle:
        handle.write(ARCHIVE_SHA256)
    log('verified sha256 %s' % digest)
    return target


def extract(force: bool = False) -> None:
    archive = download()
    os.makedirs(VENDOR, exist_ok=True)
    with zipfile.ZipFile(archive) as bundle:
        names = set(bundle.namelist())
        wanted = [face['file'] for face in FACES]
        missing = [name for name in wanted if name not in names]
        if missing:
            raise SystemExit('the archive does not contain: %s' % ', '.join(missing))
        for name in wanted:
            target = os.path.join(VENDOR, name)
            if os.path.exists(target) and not force:
                log('already extracted: %s' % name)
                continue
            with bundle.open(name) as source, open(target, 'wb') as out:
                shutil.copyfileobj(source, out, 1 << 20)
            log('extracted %s (%.1f MB)' % (name, os.path.getsize(target) / 1e6))
    # The licence ships next to the slices: OFL 1.1 requires the copyright
    # notice and the licence text to travel with the font.
    ofl = os.path.join(FONTS, 'OFL.txt')
    if not os.path.exists(ofl):
        with zipfile.ZipFile(archive) as bundle:
            for candidate in ('LICENSE.txt', 'OFL.txt'):
                if candidate in bundle.namelist():
                    with bundle.open(candidate) as source, open(ofl, 'wb') as out:
                        shutil.copyfileobj(source, out)
                    log('wrote %s' % ofl)
                    break


def subset(source: str, unicodes: str, target: str) -> int:
    """Subset `source` to `unicodes` as woff2, returning the byte size.

    A subprocess rather than in-process fontTools: measured here, reloading a
    17 MB CJK font and applying the full feature closure costs 4-9 s inside one
    process, while the same work as `python -m fontTools.subset` is 1-2 s. Most
    of that is the `--layout-features='*'` closure, which cannot be cached away.
    The cost of the extra process is the smaller half.
    """
    command = [sys.executable, '-m', 'fontTools.subset', source, *SUBSET_ARGS,
               '--unicodes=' + unicodes, '--output-file=' + target]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise SystemExit('subset failed for %s:\n%s' % (target, result.stderr.strip()))
    return os.path.getsize(target)


def ranges_of(codepoints: list[int]) -> str:
    """A compact `U+XXXX-YYYY,U+ZZZZ` form of a codepoint set."""
    spans: list[list[int]] = []
    for cp in sorted(codepoints):
        if spans and cp == spans[-1][1] + 1:
            spans[-1][1] = cp
        else:
            spans.append([cp, cp])
    return ','.join(
        'U+%04X' % a if a == b else 'U+%04X-%04X' % (a, b) for a, b in spans
    )


def codepoints_of_range(value: str) -> set[int]:
    """Every codepoint a `unicode-range` value names.

    Only the first endpoint carries the `U+` prefix ("U+4E09-4E0B"), which is
    easy to strip twice and read as 0x0B — that mistake silently turns the
    coverage check into nonsense.
    """
    out: set[int] = set()
    for span in value.split(','):
        start, _, end = span.partition('-')
        lo = int(start.strip().lstrip('Uu+'), 16)
        hi = int(end.strip().lstrip('Uu+'), 16) if end else lo
        out.update(range(lo, hi + 1))
    return out


class Sizer:
    """Slice sizes, measured rather than guessed.

    Each measurement is a real subset of a 17 MB CJK font, so the number of them
    is what the build's runtime is: a per-slice search from one glyph costs ~20
    measurements per slice, which is 20 minutes. Instead the cumulative size is
    measured once on a grid (every `GRID` glyphs of the frequency order), and a
    slice boundary is then read off that table — one measurement per slice,
    refined by bisection only inside the last grid cell.
    """

    def __init__(self, source: str, order: list[str], scratch: str):
        self.source = source
        self.order = order
        self.scratch = scratch
        self.cache: dict[tuple[int, int], int] = {}
        self.runs = 0

    def size(self, lo: int, hi: int) -> int:
        key = (lo, hi)
        if key not in self.cache:
            target = os.path.join(self.scratch, '_probe.woff2')
            self.cache[key] = subset(
                self.source, ranges_of([ord(c) for c in self.order[lo:hi]]), target
            )
            self.runs += 1
        return self.cache[key]

    def measure_grid(self, step: int) -> None:
        """Fill the cache with the cumulative size at every `step` glyphs."""
        points = list(range(step, len(self.order), step))
        last = 0
        for index, hi in enumerate(points):
            last = self.size(0, hi)
            if index % 20 == 19:
                log('  measured %d/%d grid points, %d B at %d glyphs'
                    % (index + 1, len(points), last, hi))
        log('  measured %d grid points, %d B at %d glyphs'
            % (len(points), last, points[-1] if points else 0))

    def fit(self, lo: int, cap: int = CAP_BYTES, step: int = 200, fill: float = 0.9) -> int:
        """The largest `hi` whose measured size stays within `cap`.

        Needs one measurement per `step` glyphs of slice, plus a short bisection
        inside the final cell: the grid says a 120 KB slice holds between k and
        k+step glyphs, and a few probes decide which. The bisection stops as soon
        as the slice is within `fill` of the cap — a slice that is 95% full is
        worth a kilobyte less than a perfect one and costs fewer measurements.
        """
        limit = len(self.order)
        best = lo + 1
        hi = lo + step
        while hi <= limit:
            if self.size(lo, hi) > cap:
                break
            best = hi
            hi += step
        if best >= limit:
            return limit
        high = min(limit, best + step)
        while high - best > 1 and self.size(lo, best) < fill * cap:
            middle = (best + high) // 2
            if self.size(lo, middle) <= cap:
                best = middle
            else:
                high = middle
        return best


def hanzi_bounds(sources: list[str], order: list[str], scratch: str) -> tuple[list[tuple[int, int]], int]:
    """The hanzi slice plan: one seed slice, then slices capped by measured size.

    Every face has to agree on the boundaries: the browser picks a face by
    weight, not by which slice a character landed in, so two different plans
    would mean a character that is in slice 3 at 400 and slice 4 at 600. The
    boundary is therefore the strictest of the faces — the largest cutoff that
    fits *every* weight inside the cap — which also keeps the promise the cap
    makes to a page: two or three files, no more than a cap each.
    """
    sizes = {source: Sizer(source, order, scratch) for source in sources}
    runs = 0
    first = next(iter(sizes.values()))
    seed = min(SEED_GLYPHS, len(order))
    bounds = [(0, seed)]
    seed_bytes = first.size(0, seed)
    density = seed_bytes / max(1, seed)
    log('  seed: %d glyphs, %d B (%.0f B/glyph)' % (seed, seed_bytes, density))
    while bounds[-1][1] < len(order):
        lo = bounds[-1][1]
        step = max(64, int(CAP_BYTES / density / 4))
        hi = 0
        for source, sizer in sizes.items():
            found = sizer.fit(lo, CAP_BYTES, step)
            if hi == 0 or found < hi:
                hi = found
            runs = max(runs, sizer.runs)
        bounds.append((lo, hi))
        density = first.size(lo, hi) / max(1, hi - lo)
        log('  slice %2d: ranks %5d-%5d, %4d glyphs, %7d B'
            % (len(bounds) - 1, lo, hi, hi - lo, first.size(lo, hi)))
    return bounds, sum(sizer.runs for sizer in sizes.values())


def build(face: dict, bounds: list[tuple[int, int]], order: list[str]) -> list[dict]:
    source = os.path.join(VENDOR, face['file'])
    if not os.path.exists(source):
        raise SystemExit('missing %s — run with --download --extract first' % source)

    slices: list[dict] = []
    for name, unicodes in FIXED:
        target = os.path.join(FONTS, '%s-%s.woff2' % (face['face'], name))
        size = subset(source, unicodes, target)
        slices.append({
            'kind': name, 'face': face['face'], 'weight': face['weight'],
            'file': os.path.basename(target), 'bytes': size,
            'unicodeRange': unicodes, 'glyphs': None,
        })
        log('%s: %-16s %7d B' % (face['face'], name, size))
    for index, (lo, hi) in enumerate(bounds):
        codepoints = [ord(c) for c in order[lo:hi]]
        unicodes = ranges_of(codepoints)
        target = os.path.join(FONTS, '%s-hanzi-%03d.woff2' % (face['face'], index))
        size = subset(source, unicodes, target)
        slices.append({
            'kind': 'hanzi', 'face': face['face'], 'weight': face['weight'],
            'file': os.path.basename(target), 'bytes': size,
            'unicodeRange': unicodes, 'glyphs': hi - lo, 'rank': [lo, hi],
        })
    return slices


def check() -> int:
    with open(MANIFEST, encoding='utf-8') as handle:
        manifest = json.load(handle)
    problems: list[str] = []
    faces = {face['face'] for face in FACES}
    for face in sorted(faces):
        rows = [row for row in manifest['slices'] if row['face'] == face]
        hanzi = [row for row in rows if row['kind'] == 'hanzi']
        covered: set[int] = set()
        for row in hanzi:
            here = codepoints_of_range(row['unicodeRange'])
            if len(here) != row['glyphs']:
                problems.append('%s: %s claims %d glyphs but its range names %d'
                                % (face, row['file'], row['glyphs'], len(here)))
            overlap = covered & here
            if overlap:
                problems.append('%s: %s overlaps at U+%04X' % (face, row['file'], min(overlap)))
            covered |= here
        expected = set(range(0x4E00, 0xA000))
        if covered != expected:
            missing = sorted(expected - covered)
            problems.append('%s: hanzi slices cover %d of %d codepoints (first gap U+%04X)'
                            % (face, len(covered), len(expected), missing[0] if missing else 0))
        for row in rows:
            path = os.path.join(FONTS, row['file'])
            if not os.path.exists(path):
                problems.append('%s: missing file %s' % (face, row['file']))
                continue
            actual = os.path.getsize(path)
            if actual != row['bytes']:
                problems.append('%s: %s is %d B, the manifest says %d B'
                                % (face, row['file'], actual, row['bytes']))
            with open(path, 'rb') as handle:
                if handle.read(4) != b'wOF2':
                    problems.append('%s: %s is not a woff2 file' % (face, row['file']))
    if not os.path.exists(os.path.join(FONTS, 'OFL.txt')):
        problems.append('assets/fonts/OFL.txt is missing (the licence must ship with the font)')
    if not os.path.exists(RANKED):
        problems.append('assets/fonts/ranked-hanzi.txt is missing')
    for problem in problems:
        log('check: %s' % problem)
    if not problems:
        total = sum(row['bytes'] for row in manifest['slices'])
        log('check: %d slices, %d B total, every range covered once'
            % (len(manifest['slices']), total))
    return 1 if problems else 0


def plan() -> int:
    """What an actual page pulls: hanzi bytes by how many distinct hanzi it uses."""
    with open(MANIFEST, encoding='utf-8') as handle:
        manifest = json.load(handle)
    rows = [row for row in manifest['slices'] if row['face'] == 'regular' and row['kind'] == 'hanzi']
    rows.sort(key=lambda row: row['rank'][0])
    for used in (60, 200, 1000, 3000, 20992):
        touched = [row for row in rows if row['rank'][0] < used]
        log('a page using the %-6d commonest hanzi pulls %2d slice(s), %7d B'
            % (used, len(touched), sum(row['bytes'] for row in touched)))
    log('one rare hanzi pulls at most %d B' % max(row['bytes'] for row in rows))
    log('the whole block is %d B across %d slices'
        % (sum(row['bytes'] for row in rows), len(rows)))
    return 0


def write_manifest(slices: list[dict]) -> None:
    manifest = {
        'source': {
            'family': 'JetBrains Maple Mono',
            'declaredFamily': 'DSH Code Mono',
            'release': RELEASE,
            'archive': ARCHIVE,
            'url': ARCHIVE_URL,
            'sha256': ARCHIVE_SHA256,
            'bytes': ARCHIVE_BYTES,
            'license': 'SIL OFL 1.1',
            'modification': 'renamed, subset to code+hanzi, sliced, converted to woff2',
        },
        'slicing': {
            'method': 'frequency-ordered hanzi, seed slice then a per-slice byte cap',
            'seedGlyphs': SEED_GLYPHS,
            'capBytes': CAP_BYTES,
            'order': 'ranked-hanzi.txt',
        },
        'slices': slices,
    }
    with open(MANIFEST, 'w', encoding='utf-8', newline='\n') as handle:
        json.dump(manifest, handle, indent=1, ensure_ascii=False)
        handle.write('\n')
    log('wrote %s (%d slices, %d B)'
        % (MANIFEST, len(slices), sum(row['bytes'] for row in slices)))


def main() -> int:
    global LOG_FILE
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--download', action='store_true', help='fetch and verify the archive')
    parser.add_argument('--extract', action='store_true', help='unpack the TTFs and the licence')
    parser.add_argument('--force', action='store_true', help='redo a cached download or extraction')
    parser.add_argument('--check', action='store_true', help='verify the committed slices')
    parser.add_argument('--plan', action='store_true', help='show what a page would pull')
    parser.add_argument('--log', help='append progress to this file as well as stderr')
    args = parser.parse_args()
    LOG_FILE = args.log

    if args.check:
        return check()
    if args.plan:
        return plan()
    if args.download:
        download(force=args.force)
    if args.extract:
        extract(force=args.force)
    if args.download or args.extract:
        if not os.path.exists(RANKED):
            raise SystemExit('missing %s — generate it with scripts.fonts.rank' % RANKED)
        return 0

    if not os.path.exists(RANKED):
        raise SystemExit('missing %s — generate it with scripts.fonts.rank' % RANKED)
    with open(RANKED, encoding='utf-8') as handle:
        order = handle.read().split()
    scratch = os.path.join(VENDOR, '_scratch')
    os.makedirs(scratch, exist_ok=True)
    first = os.path.join(VENDOR, FACES[0]['file'])
    sources = [os.path.join(VENDOR, face['file']) for face in FACES]
    log('planning the hanzi slices from %d faces' % len(sources))
    bounds, runs = hanzi_bounds(sources, order, scratch)
    log('%d hanzi slices after %d measurements' % (len(bounds), runs))
    slices: list[dict] = []
    for face in FACES:
        slices.extend(build(face, bounds, order))
    shutil.rmtree(scratch, ignore_errors=True)
    write_manifest(slices)
    return check()


if __name__ == '__main__':
    raise SystemExit(main())
