// @vitest-environment jsdom
// resolvePreviewImages: resolves local <img src> to inline data URIs through the
// host RPC, leaving external and already-inlined references untouched.

import { describe, expect, it, vi } from 'vitest'
import { resolvePreviewImages } from '../src/client/markdown-images.ts'

function container(html: string): HTMLElement {
  const div = document.createElement('div')
  div.innerHTML = html
  return div
}

describe('resolvePreviewImages', () => {
  it('resolves a relative src against the Markdown file directory', async () => {
    const body = container('<img src="details/photo.png">')
    const resolve = vi.fn(async () => 'data:image/png;base64,AAA')
    await resolvePreviewImages(body, '/repo/README.md', '/repo', resolve)
    expect(resolve).toHaveBeenCalledWith('/repo/details/photo.png')
    expect(body.querySelector('img')!.getAttribute('src')).toBe('data:image/png;base64,AAA')
  })

  it('treats a leading-slash src as workspace-root-relative', async () => {
    const body = container('<img src="/assets/logo.png">')
    const resolve = vi.fn(async () => 'data:image/png;base64,AAA')
    await resolvePreviewImages(body, '/repo/README.md', '/repo', resolve)
    expect(resolve).toHaveBeenCalledWith('/repo/assets/logo.png')
  })

  it('leaves absolute URLs and already-inlined data URIs untouched', async () => {
    const body = container('<img src="https://example.com/x.png"><img src="data:image/png;base64,AAA">')
    const resolve = vi.fn(async () => 'data:image/png;base64,BBB')
    await resolvePreviewImages(body, '/repo/README.md', '/repo', resolve)
    expect(resolve).not.toHaveBeenCalled()
    const imgs = body.querySelectorAll('img')
    expect(imgs[0]!.getAttribute('src')).toBe('https://example.com/x.png')
    expect(imgs[1]!.getAttribute('src')).toBe('data:image/png;base64,AAA')
  })

  it('degrades to a gray placeholder with the original path when the host cannot read the image', async () => {
    const body = container('<img src="details/photo.png">')
    const resolve = vi.fn(async () => undefined)
    await resolvePreviewImages(body, '/repo/README.md', '/repo', resolve)
    expect(body.querySelector('img')).toBeNull()
    const fallback = body.querySelector('[data-diff-md-image-fallback]') as HTMLElement
    expect(fallback).not.toBeNull()
    expect(fallback.textContent).toBe('details/photo.png')
  })

  it('degrades to a placeholder when the host call throws', async () => {
    const body = container('<img src="details/photo.png">')
    const resolve = vi.fn(async () => { throw new Error('boom') })
    await resolvePreviewImages(body, '/repo/README.md', '/repo', resolve)
    expect(body.querySelector('img')).toBeNull()
    const fallback = body.querySelector('[data-diff-md-image-fallback]') as HTMLElement
    expect(fallback).not.toBeNull()
    expect(fallback.textContent).toBe('details/photo.png')
  })

  it('ignores a fragment-only src', async () => {
    const body = container('<img src="#fig">')
    const resolve = vi.fn(async () => 'data:image/png;base64,AAA')
    await resolvePreviewImages(body, '/repo/README.md', '/repo', resolve)
    expect(resolve).not.toHaveBeenCalled()
  })
})
