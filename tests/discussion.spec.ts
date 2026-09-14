import { describe, expect, it } from 'vitest'
import {
  DISCUSSION_COMPOSE_ROWS, DISCUSSION_HEADER_ROWS, DISCUSSION_MAX_BODY_ROWS, discussionOnRange, discussionOverlapping,
  discussionPlacements, discussionRowExtras, discussionRows, discussionTail, discussionText, remapDiscussion,
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

describe('discussions in the diff row stream', () => {
  it('reserves whole rows for a block, folded or open', () => {
    // The block's height is an integer number of code rows, which is what keeps
    // the diff's prefix-sum height table exact (see the wrap model). Open without
    // a measured body it holds the compose area; a measured body replaces that.
    expect(discussionRows(discussion('a', 1, 1))).toBe(DISCUSSION_HEADER_ROWS + DISCUSSION_COMPOSE_ROWS)
    expect(discussionRows({ ...discussion('a', 1, 1), bodyRows: 4 })).toBe(DISCUSSION_HEADER_ROWS + 4)
    // An answer longer than the cap is clipped to it, so one block cannot swamp
    // the diff it annotates.
    expect(discussionRows({ ...discussion('a', 1, 1), bodyRows: 99 })).toBe(DISCUSSION_HEADER_ROWS + DISCUSSION_MAX_BODY_ROWS)
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

  it('stacks blocks that share a row instead of overlapping them', () => {
    const placements = discussionPlacements([discussion('a', 1, 2), discussion('b', 1, 2, true)], 10)
    expect(placements.get('a')).toEqual({ row: 2, belowRows: 0 })
    expect(placements.get('b')).toEqual({ row: 2, belowRows: DISCUSSION_HEADER_ROWS + DISCUSSION_COMPOSE_ROWS })
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
  })

  it('keeps the newest turns that fit the row cap, and says what it left out', () => {
    const thread = [
      { role: 'user' as const, text: 'one' },
      { role: 'assistant' as const, text: 'two' },
      { role: 'user' as const, text: 'three' },
      { role: 'assistant' as const, text: 'four' },
    ]
    const rowsOf = (): number => 2
    // Everything fits: nothing hidden, no note row.
    expect(discussionTail(thread, rowsOf, 8)).toEqual({ messages: thread, hidden: 0, rows: 8 })
    // Four rows of budget keeps the last two turns and spends one row on the note.
    const tail = discussionTail(thread, rowsOf, 5)
    expect(tail.messages).toEqual([thread[2], thread[3]])
    expect(tail.hidden).toBe(2)
    expect(tail.rows).toBe(5)
    // A single long message is still kept: something has to be visible.
    expect(discussionTail(thread, () => 40, 6).messages).toEqual([thread[3]])
    // The size is whatever the caller budgets in: the panel passes rows including
    // each message's own padding, which is why a long thread can no longer push
    // the compose row out of the block. The same two turns then cost more of the
    // budget than their bare text would (5.6 rows against 5).
    const sized = discussionTail(thread, (message) => (message.role === 'user' ? 2.4 : 2.2), 6)
    expect(sized.messages).toEqual([thread[2], thread[3]])
    expect(sized.hidden).toBe(2)
    expect(Math.round(sized.rows * 10) / 10).toBe(5.6)
    expect(discussionTail(thread, () => 2, 6).rows).toBe(5)
  })

  it('re-anchors to the rows the annotation lines landed on', () => {
    const original: Discussion = {
      ...discussion('a', 0, 0),
      anchor: { start: 1, end: 2, startLine: 10, endLine: 11 },
    }
    // The two rows moved down by one.
    const moved = remapDiscussion(original, (row) => [9, 10, 11, 12][row], 4)
    expect(moved.anchor.start).toBe(1)
    expect(moved.anchor.end).toBe(2)
    // A third row joined the range (the edit split a line in two).
    const grown = remapDiscussion(original, (row) => [10, 10, 11][row], 3)
    expect(grown.anchor).toMatchObject({ start: 0, end: 2 })
    expect(grown.lost).toBeUndefined()
    // Nothing of the range is in the file any more: stay put and say so.
    const lost = remapDiscussion(original, () => 40, 5)
    expect(lost.lost).toBe(true)
    expect(lost.anchor.start).toBe(1)
    expect(lost.anchor.end).toBe(2)
    // A lost block is not re-anchored again.
    expect(remapDiscussion(lost, (row) => [9, 10, 11, 12][row], 4)).toBe(lost)
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
