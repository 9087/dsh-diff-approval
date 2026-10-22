/**
 * Title the shell's trigger card for a COMMENT delivered from the review panel.
 *
 * A comment asked of an idle agent is delivered through the host's wake-up seam (see
 * `src/comment-ask.ts`), so the shell draws that turn's wake message as its own `turn-trigger` card —
 * the same card a scheduled reminder or a shortcut gets. The card's title comes from a CLOSED switch
 * over `source.kind` inside the shell, and a kind it does not know falls back to the generic "execution
 * requested"; there is no seam to teach it a new kind without taking over the renderer for EVERY wake
 * source. So the title is corrected here, in the DOM, joined through the node key the shell already
 * puts on the card.
 *
 * Only cards whose source kind is this plugin's own (`diff-comment`) are touched: a reminder, a goal
 * or another plugin's delivery keeps exactly the title it had.
 *
 * @module dsh-diff-approval/client/comment-card
 */

/** One delivered comment, as the chat snapshot exposes it. */
export interface CommentCardMeta {
  /** The reviewed file, as the comment recorded it. */
  path: string
  /** First new-file line of the comment's anchor. */
  startLine: number
  /** Last new-file line of the comment's anchor. */
  endLine: number
}

/** Narrow an unknown value to a record. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** Pull the node array out of a chat snapshot, by any shape the shell has used. */
function nodesOf(snapshot: unknown): unknown[] {
  const root = recordOf(snapshot)
  const nodes = recordOf(root?.nodes)
  if (nodes === undefined) return []
  const values = nodes.values
  if (typeof values === 'function') {
    try {
      const listed = values.call(nodes)
      if (Array.isArray(listed)) return listed
    } catch {
      // Fall through to the keyed reader below.
    }
  }
  const order = root?.order
  const get = nodes.get
  if (Array.isArray(order) && typeof get === 'function') {
    const collected: unknown[] = []
    for (const key of order) {
      if (typeof key !== 'string') continue
      try {
        const node = get.call(nodes, key)
        if (node !== undefined) collected.push(node)
      } catch {
        // One unreadable node must not lose the rest.
      }
    }
    return collected
  }
  return []
}

/**
 * Build the node key → comment map from one chat snapshot.
 * @param snapshot - the chat snapshot handed to the seat.
 * @returns the delivered comments, by the node key the shell puts on their card.
 */
export function buildCommentCards(snapshot: unknown): Map<string, CommentCardMeta> {
  const cards = new Map<string, CommentCardMeta>()
  for (const node of nodesOf(snapshot)) {
    const row = recordOf(node)
    if (row === undefined || typeof row.key !== 'string') continue
    const source = recordOf(recordOf(row.data)?.source)
    if (source?.kind !== 'diff-comment') continue
    const path = source.path
    const startLine = source.startLine
    const endLine = source.endLine
    if (typeof path !== 'string' || typeof startLine !== 'number' || typeof endLine !== 'number') continue
    cards.set(row.key, { path, startLine, endLine })
  }
  return cards
}

let published = new Map<string, CommentCardMeta>()
const listeners = new Set<() => void>()

/** Wake every DOM reader; a publish is not a DOM change, so the observer alone never learns of it. */
function notify(): void {
  for (const listener of [...listeners]) listener()
}

/**
 * Publish the shown conversation's delivered comments.
 * @param snapshot - the chat snapshot as the seat received it.
 */
export function publishCommentCards(snapshot: unknown): void {
  published = buildCommentCards(snapshot)
  notify()
}

/** Forget the published comments (the seat unmounted). */
export function withdrawCommentCards(): void {
  published = new Map()
  notify()
}

/** Subscribe a non-React reader to publishes. */
export function subscribeCommentCards(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The comment a delivered card came from, or undefined for every other wake source. */
export function publishedCommentCard(nodeKey: string): CommentCardMeta | undefined {
  return published.get(nodeKey)
}

/**
 * The label a card's title carries: the file's base name and the comment's lines.
 * @param meta - the delivered comment.
 * @returns `README.md:40`, or `README.md:40-42` for a multi-line anchor.
 */
export function commentCardLabel(meta: CommentCardMeta): string {
  const base = meta.path.split(/[\\/]/).pop() ?? meta.path
  const lines = meta.startLine === meta.endLine ? `${meta.startLine}` : `${meta.startLine}-${meta.endLine}`
  return `${base}:${lines}`
}

/** What the shell renders a wake card as. */
const CARD = '[data-chat-flow-kind="turn-trigger"]'

/**
 * Find the card's title element.
 *
 * The header button's children are an icon span (holding an `<svg>`), the title span, a `<time>` and a
 * chevron: selecting by position would break the moment the shell inserts a node, so the title is
 * identified by shape — the span that carries text and no icon of its own.
 * @param card - one trigger card element.
 * @returns the title span, when the card has the expected shape.
 */
function titleSpanOf(card: Element): Element | undefined {
  const header = card.querySelector('button[aria-expanded]')
  if (header === null) return undefined
  for (const child of [...header.children]) {
    if (child.tagName !== 'SPAN') continue
    if (child.querySelector('svg') !== null) continue
    return child
  }
  return undefined
}

/** The translator this decoration needs (the plugin's own namespace). */
export type CommentCardTranslate = (key: 'commentCard.title') => string

/**
 * Correct one card's title, when it belongs to a delivered comment.
 * @param card - one trigger card element.
 * @param t - translator for the plugin's namespace.
 * @returns whether the card was ours and retitled.
 */
function retitle(card: Element, t: CommentCardTranslate): boolean {
  const key = card.getAttribute('data-chat-node-key')
  if (key === null) return false
  const meta = publishedCommentCard(key)
  if (meta === undefined) return false
  const span = titleSpanOf(card)
  if (span === undefined) return false
  const title = `${t('commentCard.title')} · ${commentCardLabel(meta)}`
  if (span.textContent !== title) span.textContent = title
  card.setAttribute('data-diff-approval-comment-card', '')
  return true
}

/**
 * Title every rendered trigger card that belongs to one of our delivered comments.
 *
 * Separate from {@link attachCommentCardTitles} so the DOM pass is a plain, testable call.
 * @param t - translator for the plugin's namespace.
 */
export function titleCommentCards(t: CommentCardTranslate): void {
  if (typeof document === 'undefined') return
  for (const card of document.querySelectorAll(CARD)) retitle(card, t)
}

/**
 * Title delivered comments' cards, and keep them titled as the chat re-renders.
 *
 * Returns early without a `document`, like every DOM bridge in this plugin: the published bundle is
 * exercised in headless harnesses where those globals do not exist, and a decoration must never be the
 * reason a plugin fails to load.
 * @param options - the plugin's translator.
 * @returns a disposer that stops observing (the cards unmount with the view).
 */
export function attachCommentCardTitles(options: { t: CommentCardTranslate }): () => void {
  if (typeof document === 'undefined') return () => {}
  const { t } = options
  let frame = 0
  let disposed = false

  const ensure = (): void => {
    frame = 0
    if (disposed) return
    titleCommentCards(t)
  }

  const schedule = (): void => {
    if (disposed || frame !== 0) return
    frame = requestAnimationFrame(ensure)
  }

  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  const unsubscribe = subscribeCommentCards(schedule)
  schedule()

  return () => {
    disposed = true
    unsubscribe()
    observer.disconnect()
    if (frame !== 0) cancelAnimationFrame(frame)
    frame = 0
  }
}
