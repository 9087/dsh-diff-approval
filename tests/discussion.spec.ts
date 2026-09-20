import { describe, expect, it } from 'vitest'
import {
  DISCUSSION_COMPOSE_ROWS, DISCUSSION_HEADER_ROWS, discussionOnRange,
  discussionOverlapping, discussionPlainText, discussionRowExtras, discussionRows, discussionRounds,
  discussionRuns, discussionText, remapDiscussion, remapDiscussions,
  selectionFrame, stripBlankLines,
} from '../src/client/discussion.ts'
import type { Discussion } from '../src/client/discussion.ts'

/** One discussion, folded or open, with its lines derived from the rows. */
function discussion(id: string, start: number, end: number, collapsed = false): Discussion {
  return {
    id,
    anchor: { start, end, startLine: start + 1, endLine: end + 1 },
    messages: [],
    draft: '',
    collapsed,
  }
}

/** One model to re-anchor against: new-file lines (an old-side row has none) and texts. */
function rows(lines: readonly (number | undefined)[], texts: readonly string[]) {
  const lineOf = (row: number): number | undefined => lines[row]
  const textOf = (row: number): string => texts[row] ?? ''
  return { lineOf, textOf, rowCount: lines.length, hasNewLine: (row: number): boolean => lines[row] !== undefined }
}

/** Re-anchor one discussion against a model, the way the panel's rebuild effect does. */
function remap(discussion: Discussion, model: ReturnType<typeof rows>): Discussion {
  return remapDiscussion(discussion, model.lineOf, model.textOf, model.rowCount, model.hasNewLine)
}

describe('discussions in the diff row stream', () => {
  it('reserves whole rows for a block, folded or open', () => {
    // The block's height is an integer number of code rows, which is what keeps
    // the diff's prefix-sum height table exact (see the wrap model). Open without
    // a measured body it holds the compose area; a measured body replaces that.
    expect(discussionRows(discussion('a', 1, 1))).toBe(DISCUSSION_HEADER_ROWS + DISCUSSION_COMPOSE_ROWS)
    expect(discussionRows({ ...discussion('a', 1, 1), bodyRows: 4 })).toBe(DISCUSSION_HEADER_ROWS + 4)
    // A body longer than the cap is carried in full: the cap is spent on whole older turns
    // (see `discussionTail`), and a box shorter than the text it holds is what cut the last
    // turn off mid-paragraph - the text was rendered whole inside it and clipped.
    expect(discussionRows({ ...discussion('a', 1, 1), bodyRows: 99 })).toBe(DISCUSSION_HEADER_ROWS + 99)
    expect(discussionRows(discussion('a', 1, 1, true))).toBe(DISCUSSION_HEADER_ROWS)
  })

  it('charges a block\'s rows to the row it hangs below', () => {
    const extras = discussionRowExtras([discussion('a', 2, 4)], 10)
    expect([...extras]).toEqual([[4, DISCUSSION_HEADER_ROWS + DISCUSSION_COMPOSE_ROWS]])

    // Blocks on one row sum, so the reservation covers both.
    const shared = discussionRowExtras([discussion('a', 2, 4), discussion('b', 3, 4, true)], 10)
    expect(shared.get(4)).toBe(DISCUSSION_HEADER_ROWS + DISCUSSION_COMPOSE_ROWS + DISCUSSION_HEADER_ROWS)

    // A stale anchor (rows shrank under it) clamps instead of writing out of range.
    const stale = discussionRowExtras([discussion('a', 2, 99)], 5)
    expect(stale.get(4)).toBe(DISCUSSION_HEADER_ROWS + DISCUSSION_COMPOSE_ROWS)

    expect(discussionRowExtras([], 5).size).toBe(0)
  })

  it('matches a range exactly, and sees any overlap as already discussed', () => {
    const discussions = [discussion('a', 2, 4)]
    expect(discussionOnRange(discussions, { start: 2, end: 4 })?.id).toBe('a')
    expect(discussionOnRange(discussions, { start: 2, end: 3 })).toBeUndefined()
    // Any shared row counts: one row belongs to one annotation.
    expect(discussionOverlapping(discussions, { start: 2, end: 3 })?.id).toBe('a')
    expect(discussionOverlapping(discussions, { start: 4, end: 9 })?.id).toBe('a')
    expect(discussionOverlapping(discussions, { start: 3, end: 3 })?.id).toBe('a')
    expect(discussionOverlapping(discussions, { start: 5, end: 9 })).toBeUndefined()
    // An outdated thread owns no rows: the code under its numbers is not what it was about
    // any more, so the rows are free for an annotation of the code that is there now.
    const outdated = [{ ...discussion('b', 2, 4), lost: true }]
    expect(discussionOverlapping(outdated, { start: 3, end: 3 })).toBeUndefined()
    expect(discussionOverlapping([...discussions, ...outdated], { start: 3, end: 3 })?.id).toBe('a')
  })

  it('keeps the newest rounds, and says what it left out', () => {
    const thread = [
      { role: 'user' as const, text: 'one' },
      { role: 'assistant' as const, text: 'two' },
      { role: 'user' as const, text: 'three' },
      { role: 'assistant' as const, text: 'four' },
      { role: 'user' as const, text: 'five' },
      { role: 'assistant' as const, text: 'six' },
    ]
    const rowsOf = (): number => 2
    // Nothing to hide while the thread is at or under the cap, so no note row either.
    expect(discussionRounds(thread.slice(0, 4), 2, rowsOf))
      .toEqual({ messages: thread.slice(0, 4), hidden: 0, rows: 8 })
    // Three rounds: the oldest question and its answer go, and the note costs one row.
    const tail = discussionRounds(thread, 2, rowsOf)
    expect(tail.messages).toEqual([thread[2], thread[3], thread[4], thread[5]])
    expect(tail.hidden).toBe(2)
    expect(tail.rows).toBe(9)
    // The unit is the round, not a row budget: a round's size is only what it costs.
    const sized = discussionRounds(thread, 1, (message) => (message.role === 'user' ? 2.4 : 2.2))
    expect(sized.messages).toEqual([thread[4], thread[5]])
    expect(sized.hidden).toBe(4)
    expect(sized.rows).toBe(5.6) // the round's own 4.6 rows, plus the one row its note takes
    expect(discussionRounds(thread, 1, () => 40).messages).toEqual([thread[4], thread[5]])
    // A question whose answer is still on its way is a round of its own, and is kept.
    expect(discussionRounds(thread.slice(0, 5), 1, rowsOf).messages).toEqual([thread[4]])
    // At least one round is always kept, whatever the caller asks for: something has to show.
    expect(discussionRounds(thread, 0, rowsOf).messages).toHaveLength(2)
    expect(discussionRounds([], 2, rowsOf)).toEqual({ messages: [], hidden: 0, rows: 0 })
  })

  it('reads a turn\'s inline code and bold, and leaves everything else as typed', () => {
    expect(discussionRuns('a `b` **c** d')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'code', text: 'b' },
      { kind: 'text', text: ' ' },
      { kind: 'strong', text: 'c' },
      { kind: 'text', text: ' d' },
    ])
    // A marker with no partner, or one spanning a line break, is not a marker: the thread is
    // laid out a line at a time, so nothing here may open a block or swallow a row.
    expect(discussionRuns('a `b')).toEqual([{ kind: 'text', text: 'a `b' }])
    expect(discussionRuns('**a\nb**')).toEqual([{ kind: 'text', text: '**a\nb**' }])
    expect(discussionRuns('``')).toEqual([{ kind: 'text', text: '``' }])
    expect(discussionRuns('****')).toEqual([{ kind: 'text', text: '****' }])
    // The measurement reads the text the runs draw, never the markers.
    expect(discussionPlainText('a `b` **c**')).toBe('a b c')
    expect(discussionPlainText('no markers')).toBe('no markers')
  })

  it('re-anchors by line numbers while they hold the quote, and by quote when they do not', () => {
    // An annotation on new-file lines 10-11, quoted as the two lines read then.
    const original: Discussion = {
      ...discussion('a', 0, 0),
      anchor: { start: 1, end: 2, startLine: 10, endLine: 11 },
      quote: 'one\ntwo',
    }
    // Two context rows were inserted above: the numbers move, the code under them does
    // not, so the line numbers are the answer and nothing else has to be searched.
    const moved = remap(original, rows([1, 2, 3, 10, 11], ['a', 'b', 'c', 'one', 'two']))
    expect(moved.anchor).toMatchObject({ start: 3, end: 4 })
    expect(moved.lost).toBeUndefined()
    // Nothing moved: the very same object comes back, so a rebuild that changed nothing
    // does not churn the blocks (the panel reads state identity as its change signal).
    expect(remap(original, rows([9, 10, 11, 12], ['a', 'one', 'two', 'b']))).toBe(original)
    // An edit split the last line in two: a third row joined the range, and the content
    // under the numbers still starts with the quote, so the numbers are followed.
    const grown = remap(original, rows([10, 11, 11], ['one', 'two', 'two']))
    expect(grown.anchor).toMatchObject({ start: 0, end: 2 })
    expect(grown.lost).toBeUndefined()
    // The old numbers now sit over other code, and the quote is elsewhere: the thread
    // follows the code it was written about - nearest occurrence first.
    const followed = remap(original, rows([1, 2, 3, 10, 11], ['x', 'one', 'two', 'y', 'z']))
    expect(followed.anchor).toMatchObject({ start: 1, end: 2, startLine: 2, endLine: 3 })
    expect(followed.lost).toBeUndefined()
  })

  it('follows a quote only where its recorded context reads the same, and condemns the rest', () => {
    // The quote alone is too weak a fingerprint: a comment on a common line — a closing brace, a blank
    // line — matches that line somewhere else in the file, and the thread used to follow it and stay
    // live however thoroughly the code under its numbers had been rewritten. The context recorded with
    // the thread is what tells a genuine move from that coincidence.
    const moved: Discussion = {
      ...discussion('a', 0, 0),
      anchor: { start: 3, end: 3, startLine: 10, endLine: 10 },
      quote: 'b',
      quoteContext: 'a\nb\nc',
    }
    // The numbers hold other code now, but 'a b c' sits together elsewhere: quote and context moved as
    // one, so the thread follows the code it was about.
    const followed = remap(moved, rows([1, 2, 3, 10], ['a', 'b', 'c', 'z']))
    expect(followed.lost).toBeUndefined()
    expect(followed.anchor).toMatchObject({ start: 1, end: 1, startLine: 2, endLine: 2 })
    // A 'b' whose neighbours read differently is not it, so the thread is outdated rather than carried
    // off to a line that merely looks the same.
    expect(remap(moved, rows([1, 2, 3, 10], ['b', 'x', 'b', 'z'])).lost).toBe(true)
    // A thread with no recorded context (from before it was kept) still follows the quote alone.
    const bare = { ...moved, quoteContext: undefined }
    expect(remap(bare, rows([1, 2, 3, 10], ['b', 'x', 'b', 'z'])).lost).toBeUndefined()
  })

  it('condemns a comment on a blank line once that line holds code', () => {
    // A blank line quotes as an empty string, which used to mean "nothing to compare against": the
    // thread stayed live however the code under it was rewritten. Its recorded context makes the blank
    // window a fact like any other.
    const blank: Discussion = {
      ...discussion('a', 1, 1),
      anchor: { start: 1, end: 1, startLine: 2, endLine: 2 },
      quote: '',
      quoteContext: 'a\n\nb',
    }
    // Still blank there: live.
    expect(remap(blank, rows([1, 2, 3], ['a', '', 'b'])).lost).toBeUndefined()
    // The line holds code now: outdated, and the blank line further down the file is not followed —
    // its context is not the one the thread recorded.
    expect(remap(blank, rows([1, 2, 3, 4], ['a', 'const x = 1', 'b', ''])).lost).toBe(true)
  })

  it('condemns a comment whose code survives only in the pending deletions', () => {
    // The code was moved and then rewritten where it landed: the new side no longer reads like the
    // quote, but the old side — the deletion the diff is offering to take away — still does. Following
    // that copy is what used to leave the thread looking current after its whole function had changed.
    const original: Discussion = {
      ...discussion('a', 3, 4),
      anchor: { start: 3, end: 4, startLine: 193, endLine: 194 },
      quote: 'Left (bShift),\nRight (bShift),',
    }
    // The old side of the move: those rows have no new-file line at all, which is what says the code
    // they hold is the copy the diff is offering to take away.
    const oldCopy = rows([undefined, undefined, 193, 194], [
      'Left (bShift),',
      'Right (bShift),',
      'Left (bShift),  // LeftShift',
      'Right (bShift),  // RightShift',
    ])
    expect(remap(original, oldCopy).lost).toBe(true)
    // A copy the file still HAS is followed, as it always was: the same two lines again, further down.
    const liveCopy = rows([193, 194, 240, 241], [
      'Left (bShift),  // LeftShift',
      'Right (bShift),  // RightShift',
      'Left (bShift),',
      'Right (bShift),',
    ])
    const followed = remap(original, liveCopy)
    expect(followed.lost).toBeUndefined()
    expect(followed.anchor).toMatchObject({ start: 2, end: 3 })
  })

  it('marks a thread outdated when the code it was about is gone, and clears the mark when it returns', () => {
    const original: Discussion = {
      ...discussion('a', 1, 2),
      anchor: { start: 1, end: 2, startLine: 10, endLine: 11 },
      quote: 'one\ntwo',
    }
    // Nothing of the range holds the quote and the quote is nowhere else: the thread says it is
    // outdated, keeps its quote for the reader, and hangs by the LINES it names — the rows of this
    // model, not the row index it last matched.
    const gone = remap(original, rows([1, 2, 10, 12], ['a', 'b', 'y', 'z']))
    expect(gone.lost).toBe(true)
    expect(gone.anchor).toEqual({ start: 2, end: 2, startLine: 10, endLine: 11 })
    expect(gone.quote).toBe('one\ntwo')
    // A further edit above it moves the rows, not the block: an outdated thread used to walk down the
    // file one rebuild at a time, because it hung on a row index that every insert shifts.
    const shifted = remap(gone, rows([1, 2, 3, 10, 11], ['a', 'b', 'c', 'y', 'z']))
    expect(shifted.lost).toBe(true)
    expect(shifted.anchor).toMatchObject({ start: 3, end: 4, startLine: 10, endLine: 11 })
    // The whole range gone from the model is the one case where the block moves, and it moves by
    // line number: back to where the range used to be — under the last row that still reads
    // before it — rather than on the row index it last matched (which drifts with every edit
    // above the block, and lands at the file's end once the file is shorter).
    const removed = { ...original, anchor: { start: 5, end: 6, startLine: 10, endLine: 11 } }
    const rehung = remap(removed, rows([1, 2, 3], ['a', 'b', 'c']))
    expect(rehung.lost).toBe(true)
    expect(rehung.anchor).toEqual({ start: 2, end: 2, startLine: 10, endLine: 11 })
    // Already there: the same object, no churn.
    expect(remap(rehung, rows([1, 2, 3], ['a', 'b', 'c']))).toBe(rehung)
    // The lines are gone from the model entirely (a revert took the hunk out).
    expect(remap(original, rows([1, 2], ['a', 'b'])).lost).toBe(true)
    // Outdated is derived, not sticky: a keep bringing the lines back with their quote
    // clears it, so a thread is not condemned by one rebuild.
    const back = remap(gone, rows([10, 11], ['one', 'two']))
    expect(back.lost).toBeUndefined()
    expect(back.anchor).toMatchObject({ start: 0, end: 1 })
    // Already outdated, and its range is gone from this model too: it is put back where the range
    // used to be — once — and then stays there, the same object on the next rebuild.
    const rehungAgain = remap(gone, rows([1, 2], ['a', 'b']))
    expect(rehungAgain.lost).toBe(true)
    expect(rehungAgain.anchor).toEqual({ start: 1, end: 1, startLine: 10, endLine: 11 })
    expect(remap(rehungAgain, rows([1, 2], ['a', 'b']))).toBe(rehungAgain)
  })

  it('compares a quote over a changed line by its own rows, not by the anchor\'s line span', () => {
    // A modification is two rows — the line removed and the line that replaced it — but a single
    // new-file number, because the removed row has none of its own. Reading the row span off
    // `endLine - startLine` compared a one-row window against a two-row quote, so every comment
    // over a change was condemned the first time anything rebuilt the rows (switching files, a
    // keep, an edit above it). The quote's own line count is the row count.
    const original: Discussion = {
      ...discussion('a', 0, 1),
      anchor: { start: 0, end: 1, startLine: 1, endLine: 1 },
      quote: 'const old = 1\nconst next = 2',
    }
    // The very same rows come back: nothing moves, and the thread stays live.
    const same = remap(original, rows([undefined, 1, 2], ['const old = 1', 'const next = 2', 'keep']))
    expect(same.lost).toBeUndefined()
    expect(same.anchor).toMatchObject({ start: 0, end: 1 })
    // Two context rows above it: the numbers move, the quote is found by its own rows, and the
    // thread follows it there rather than being marked outdated.
    const moved = remap(original, rows([1, 2, undefined, 3, 4], ['a', 'b', 'const old = 1', 'const next = 2', 'keep']))
    expect(moved.lost).toBeUndefined()
    expect(moved.anchor).toMatchObject({ start: 2, end: 3 })
  })

  it('re-anchors a whole list in one pass, exactly as it does one block at a time', () => {
    // The panel's rebuild path: every block of a file, against one model. It has to agree with the
    // single-block call field for field — and keep its identity contract, because a block that did
    // not move coming back as the same object is how the panel knows a rebuild changed nothing.
    const moved: Discussion = {
      ...discussion('moved', 5, 6),
      anchor: { start: 5, end: 6, startLine: 10, endLine: 11 },
      quote: 'one\ntwo',
    }
    const gone: Discussion = {
      ...discussion('gone', 7, 8),
      anchor: { start: 7, end: 8, startLine: 99, endLine: 100 },
      quote: 'nowhere',
    }
    const still: Discussion = {
      ...discussion('still', 0, 0),
      anchor: { start: 0, end: 0, startLine: 1, endLine: 1 },
      quote: 'a',
    }
    const model = rows([1, 2, 10, 11], ['a', 'b', 'one', 'two'])
    const blocks = [moved, gone, still]
    const oneByOne = blocks.map(block => remap(block, model))
    const inOnePass = remapDiscussions(blocks, model.lineOf, model.textOf, model.rowCount)
    expect(inOnePass).toEqual(oneByOne)
    expect(inOnePass[2]).toBe(still)
    expect(oneByOne[2]).toBe(still)
    expect(inOnePass[1]!.lost).toBe(true)
    expect(inOnePass[0]!.anchor).toMatchObject({ start: 2, end: 3 })
  })

  it('trusts the line numbers for a thread with no quote to check against', () => {
    // A comment from a build that did not store one (or one whose rows made an empty
    // quote): the numbers are all there is, so they are followed as they always were.
    const original: Discussion = {
      ...discussion('a', 0, 0),
      anchor: { start: 1, end: 2, startLine: 10, endLine: 11 },
    }
    const moved = remap(original, rows([9, 10, 11, 12], ['a', 'b', 'c', 'd']))
    expect(moved.anchor).toMatchObject({ start: 1, end: 2 })
    expect(moved.lost).toBeUndefined()
    // With those numbers gone there is nothing left to anchor on, so the thread is
    // outdated rather than sitting silently on whatever rows now exist.
    expect(remap(original, rows([1, 2], ['a', 'b'])).lost).toBe(true)
  })

  it('offers keep/revert only over change blocks, and never a second discussion', () => {
    // Covered blocks and no discussion yet: all three actions.
    expect(selectionFrame({ coversBlocks: true, hasDiscussion: false }))
      .toEqual({ keepRevert: true, comment: true, visible: true })

    // A plain code range: commenting is the only action, and the frame still shows.
    expect(selectionFrame({ coversBlocks: false, hasDiscussion: false }))
      .toEqual({ keepRevert: false, comment: true, visible: true })

    // An already-discussed plain range has nothing to offer, so no frame at all.
    expect(selectionFrame({ coversBlocks: false, hasDiscussion: true }))
      .toEqual({ keepRevert: false, comment: false, visible: false })

    // An already-discussed range that covers blocks keeps keep/revert.
    expect(selectionFrame({ coversBlocks: true, hasDiscussion: true }))
      .toEqual({ keepRevert: true, comment: false, visible: true })
  })

  it('drops an answer\'s blank lines, and only an answer\'s', () => {
    // A blank line is a whole code row of height in the thread, which is what made
    // an answer look scattered. The agent is asked not to write them, and any that
    // arrive are collapsed on the way in — by the render and by the row measurement
    // alike, so they cannot disagree about how tall the turn is.
    expect(stripBlankLines('one\n\ntwo\n   \nthree')).toBe('one\ntwo\nthree')
    expect(stripBlankLines('\n\nonly\n\n')).toBe('only')
    expect(stripBlankLines('no breaks here')).toBe('no breaks here')
    // What the user typed is theirs: their blank lines are shown as written.
    expect(discussionText({ role: 'assistant', text: 'a\n\nb' })).toBe('a\nb')
    expect(discussionText({ role: 'user', text: 'a\n\nb' })).toBe('a\n\nb')
  })
})
