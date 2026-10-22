// The trigger-card bridge for delivered review comments: which chat nodes are ours, the label a card
// carries, and the DOM retitle the shell's generic card gets.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  attachCommentCardTitles, buildCommentCards, commentCardLabel, publishCommentCards,
  publishedCommentCard, subscribeCommentCards, titleCommentCards, withdrawCommentCards,
} from '../src/client/comment-card.ts'

/** The title the plugin uses in these assertions (the dictionaries' own words are covered by parity). */
const t = (): string => '代码评论'

/** A chat snapshot in the shape the shell publishes: `nodes.values()`. */
function snapshotOf(nodes: unknown[]): unknown {
  return { nodes: { values: () => nodes } }
}

/** One delivered comment's wake message, as the snapshot exposes it. */
function commentNode(key: string, path: string, startLine: number, endLine: number): unknown {
  return {
    key,
    kind: 'turn-trigger',
    data: {
      role: 'user',
      content: [{ type: 'text', text: '[评论] (README.md:2) 「why?」' }],
      source: { kind: 'diff-comment', rpcId: 'request-1', path, startLine, endLine },
    },
  }
}

/** The DOM a trigger card renders: icon span, title span, time, chevron. */
function card(key: string, title: string): HTMLElement {
  const card = document.createElement('div')
  card.setAttribute('data-chat-flow-kind', 'turn-trigger')
  card.setAttribute('data-chat-node-key', key)
  card.innerHTML = `<button aria-expanded="true"><span><svg></svg></span><span>${title}</span><time>12:00</time><svg></svg></button>`
  document.body.append(card)
  return card
}

describe('comment-card', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    withdrawCommentCards()
  })

  it('collects only the nodes whose source is this plugin\'s own delivery', () => {
    const cards = buildCommentCards(snapshotOf([
      commentNode('k1', 'C:\\repo\\README.md', 40, 42),
      { key: 'k2', data: { source: { kind: 'schedule' } } },
      { key: 'k3', data: { source: { kind: 'shortcut', shortcutName: '测试' } } },
      { key: 'k4', data: { role: 'user', content: [] } },
      // A diff-comment source without the fields the label needs is not a card this plugin can title.
      { key: 'k5', data: { source: { kind: 'diff-comment', path: 'x.md' } } },
    ]))
    expect([...cards.keys()]).toEqual(['k1'])
    expect(cards.get('k1')).toEqual({ path: 'C:\\repo\\README.md', startLine: 40, endLine: 42 })
  })

  it('also reads the keyed node shape (order + get)', () => {
    const nodes = new Map<string, unknown>([
      ['k1', commentNode('k1', '/repo/README.md', 2, 2)],
      ['k2', { key: 'k2', data: {} }],
    ])
    const snapshot = {
      order: ['k1', 'k2'],
      nodes: { get: (key: string) => nodes.get(key) },
    }
    expect([...buildCommentCards(snapshot).keys()]).toEqual(['k1'])
  })

  it('labels a card with the file and its lines', () => {
    expect(commentCardLabel({ path: 'C:\\repo\\docs\\README.md', startLine: 40, endLine: 40 })).toBe('README.md:40')
    expect(commentCardLabel({ path: '/repo/README.md', startLine: 40, endLine: 42 })).toBe('README.md:40-42')
  })

  it('publishes and withdraws, waking subscribers without a DOM change', () => {
    let woke = 0
    const unsubscribe = subscribeCommentCards(() => { woke += 1 })
    publishCommentCards(snapshotOf([commentNode('k1', '/repo/a.md', 2, 2)]))
    expect(publishedCommentCard('k1')).toEqual({ path: '/repo/a.md', startLine: 2, endLine: 2 })
    expect(woke).toBe(1)
    withdrawCommentCards()
    expect(publishedCommentCard('k1')).toBeUndefined()
    expect(woke).toBe(2)
    unsubscribe()
  })

  it('retitles OUR card with the file and lines, and leaves other wake cards alone', () => {
    publishCommentCards(snapshotOf([commentNode('ours', '/repo/README.md', 40, 40)]))
    const ours = card('ours', '收到执行请求')
    const theirs = card('theirs', '自动化任务')

    titleCommentCards(t)

    const titleOf = (element: HTMLElement): string =>
      [...element.querySelectorAll('button[aria-expanded] > span')]
        .filter(span => span.querySelector('svg') === null)
        .map(span => span.textContent)[0] ?? ''
    expect(titleOf(ours)).toBe('代码评论 · README.md:40')
    expect(ours.hasAttribute('data-diff-approval-comment-card')).toBe(true)
    expect(titleOf(theirs)).toBe('自动化任务')
    expect(theirs.hasAttribute('data-diff-approval-comment-card')).toBe(false)
  })

  it('re-applies the title through the observer as the chat re-renders the card', async () => {
    const dispose = attachCommentCardTitles({ t })
    try {
      card('ours-2', '收到执行请求')
      publishCommentCards(snapshotOf([commentNode('ours-2', '/repo/b.md', 7, 8)]))
      await vi.waitFor(() => {
        const element = document.querySelector('[data-chat-node-key="ours-2"]') as HTMLElement
        expect(element.textContent).toContain('代码评论 · b.md:7-8')
      })
    } finally {
      dispose()
    }
  })
})
