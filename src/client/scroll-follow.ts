/**
 * The floating action frame's vertical position, as scroll-driven keyframes.
 *
 * The frame follows the row its anchor ends on — a point in the scroller's CONTENT
 * coordinates — and is clamped into the visible area, so that it stays clickable when
 * that row is off-screen. Written the direct way ("read `scrollTop`, subtract, clamp")
 * it has to be recomputed on the main thread for every scroll event, which leaves it a
 * frame behind the code the compositor has already moved. The same clamp expressed as
 * keyframes over the scroll range becomes a scroll-driven animation, which the browser
 * runs off the main thread: the code and the frame never disagree about the offset.
 *
 * The clamp is piecewise linear in the scroll offset, with exactly two corners — where
 * the frame stops being held down by the viewport's bottom edge, and where it reaches
 * the viewport's top edge and stays there — so listing those stops makes the animation
 * reproduce it exactly, not approximately.
 *
 * @param anchorTop - the anchor's offset in the scroller's content, in px.
 * @param maxScroll - the scroller's maximum `scrollTop` (0 when it does not scroll).
 * @param viewportHeight - the scroller's client height, in px.
 * @param frameHeight - the frame's own height, which the clamp has to keep on screen.
 * @returns the keyframe stops: `offset` is the scroll progress (0-1) and `y` the frame's
 *  position in px from the viewport's top. Ascending, deduplicated, and including the
 *  corners; with nothing to scroll there is a single stop, the clamp being constant.
 */
export function frameFollowKeyframes(
  anchorTop: number,
  maxScroll: number,
  viewportHeight: number,
  frameHeight: number,
): { offset: number; y: number }[] {
  const limit = Math.max(0, viewportHeight - frameHeight)
  const at = (progress: number): number => Math.min(limit, Math.max(0, anchorTop - progress * maxScroll))
  if (maxScroll <= 0) return [{ offset: 0, y: at(0) }]
  const release = (anchorTop - limit) / maxScroll
  const pinned = anchorTop / maxScroll
  const offsets = [0, release, pinned, 1].filter(offset => offset >= 0 && offset <= 1)
  return [...new Set(offsets)].sort((left, right) => left - right).map(offset => ({ offset, y: at(offset) }))
}
