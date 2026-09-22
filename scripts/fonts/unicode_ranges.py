"""Read the `unicode-range` a slice file was cut for, back out of the woff2."""
from __future__ import annotations

import sys

from fontTools.ttLib import TTFont


def unicode_range(path: str) -> str:
    font = TTFont(path, lazy=True)
    codepoints = sorted(font.getBestCmap())
    font.close()
    spans: list[list[int]] = []
    for cp in codepoints:
        if spans and cp == spans[-1][1] + 1:
            spans[-1][1] = cp
        else:
            spans.append([cp, cp])
    return ','.join('U+%04X' % a if a == b else 'U+%04X-%04X' % (a, b) for a, b in spans)


if __name__ == '__main__':
    for path in sys.argv[1:]:
        print('%s\t%s' % (path, unicode_range(path)))
