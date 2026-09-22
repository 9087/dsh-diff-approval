"""Rank the hanzi of U+4E00-9FFF by frequency, for the font slice pipeline.

The slicing half of the pipeline (`scripts/fonts/build.py`) needs one fixed
character order and nothing else: which glyphs share a slice decides how many
bytes a page pulls, and the order is a property of the language, not of the
font. Keeping it in a committed file means a font update re-slices the same
groups, and a slice-rule change re-slices the same order.

The committed order is `assets/fonts/ranked-hanzi.txt`, produced once by this
script (or by any better frequency source) and then frozen. Regenerating it is
a deliberate act, not part of a build: slices are content-addressed by it.

Sources, in order of preference:
  1. `wordfreq`'s large Chinese data, which carries real running-text
     frequencies for single characters (的 ≈ 6%).
  2. `wordfreq.top_n_list('zh', 20000)`, a coarser cross-check.
  3. Jun Da's 2004 corpus list (MTSU, ~193M characters), to catch characters
     the other two miss.
Characters in none of them go last, so the order covers U+4E00-9FFF exactly
once. That a character is rare in a 2004 corpus does not mean it is rare in
someone's comments, so the leftover tail is a real part of the order.

Usage:
  python -m scripts.fonts.rank --out "assets/fonts/ranked-hanzi.txt"
  python -m scripts.fonts.rank --check          # verify the committed file
"""
from __future__ import annotations

import argparse
import os
import sys
import unicodedata
import urllib.request

RANGE = range(0x4E00, 0xA000)
JUN_DA_URL = 'https://lingua.mtsu.edu/chinese-computing/statistics/char/list.php?Which=MO'


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def wordfreq_ranking() -> list[str]:
    """Single hanzi ranked by wordfreq's own running-text frequency."""
    from wordfreq import zipf_frequency

    candidates = {chr(cp) for cp in RANGE}
    words = [w for w in _wordfreq_words() if w in candidates]
    log('wordfreq single-character list: %d hanzi' % len(words))
    return sorted(words, key=lambda w: (-zipf_frequency(w, 'zh'), w))


def _wordfreq_words() -> list[str]:
    """The largest Chinese word list wordfreq ships, single characters only."""
    from wordfreq import iter_wordlist

    try:
        words = list(iter_wordlist('zh', wordlist='large'))
    except TypeError:  # older wordfreq: no wordlist argument
        words = list(iter_wordlist('zh'))
    return [w for w in words if len(w) == 1 and unicodedata.category(w) == 'Lo']


def topn_ranking() -> list[str]:
    from wordfreq import top_n_list

    out = [w for w in top_n_list('zh', 20000) if len(w) == 1 and ord(w) in RANGE]
    log('wordfreq top_n_list: %d hanzi' % len(out))
    return out


def jun_da_ranking() -> list[str]:
    """Jun Da's corpus list, most frequent first. A network failure is not fatal."""
    try:
        with urllib.request.urlopen(JUN_DA_URL, timeout=60) as response:
            body = response.read().decode('utf-8', 'replace')
    except Exception as error:  # pragma: no cover - network dependent
        log('jun da list unavailable (%s); continuing with the wordfreq sources' % error)
        return []
    seen: set[str] = set()
    ranked: list[str] = []
    for char in body:
        if ord(char) in RANGE and char not in seen:
            seen.add(char)
            ranked.append(char)
    log('jun da list: %d hanzi' % len(ranked))
    return ranked


def merged_ranking() -> list[str]:
    best: dict[str, int] = {}
    for source in (wordfreq_ranking(), topn_ranking(), jun_da_ranking()):
        for index, char in enumerate(source):
            if char not in best or index < best[char]:
                best[char] = index
    ranked = sorted(best, key=lambda c: (best[c], ord(c)))
    log('merged ranked hanzi: %d' % len(ranked))
    leftovers = [chr(cp) for cp in RANGE if chr(cp) not in best]
    log('hanzi in no source list (placed last): %d' % len(leftovers))
    return ranked + leftovers


def check(path: str) -> int:
    with open(path, encoding='utf-8') as handle:
        order = handle.read().split()
    problems: list[str] = []
    if len(order) != len(RANGE):
        problems.append('has %d lines, expected %d' % (len(order), len(RANGE)))
    if len(set(order)) != len(order):
        problems.append('contains duplicates')
    missing = sorted(set(RANGE) - {ord(c) for c in order})
    extra = sorted({ord(c) for c in order} - set(RANGE))
    if missing:
        problems.append('missing %d codepoints, first U+%04X' % (len(missing), missing[0]))
    if extra:
        problems.append('%d codepoints outside the block, first U+%04X' % (len(extra), extra[0]))
    for problem in problems:
        log('ranked-hanzi: %s' % problem)
    if not problems:
        log('ranked-hanzi: %d hanzi, covers U+4E00-9FFF exactly' % len(order))
    return 1 if problems else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', help='write the order here, one hanzi per line')
    parser.add_argument('--codepoints-out', help='optional "U+XXXX" per line, same order')
    parser.add_argument('--check', metavar='FILE', help='verify a committed order file')
    args = parser.parse_args()
    if args.check:
        return check(args.check)
    if not args.out:
        parser.error('either --out or --check is required')

    order = merged_ranking()
    assert len(order) == len(RANGE), 'the order must have one entry per codepoint'
    assert len(set(order)) == len(order), 'the order must not repeat a codepoint'
    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or '.', exist_ok=True)
    with open(args.out, 'w', encoding='utf-8', newline='\n') as handle:
        handle.write('\n'.join(order) + '\n')
    if args.codepoints_out:
        with open(args.codepoints_out, 'w', encoding='utf-8', newline='\n') as handle:
            handle.write('\n'.join('U+%04X' % ord(c) for c in order) + '\n')
    log('wrote %d hanzi to %s' % (len(order), args.out))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
