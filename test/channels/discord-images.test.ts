import { afterAll, describe, expect, test } from 'bun:test'
import { withImages } from '../../src/channels/discord-images'

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
const host = Bun.serve({
  port: 0,
  fetch(req) {
    const p = new URL(req.url).pathname
    if (p === '/images/2026-10-06/cat.png')
      return new Response(PNG, { headers: { 'content-type': 'image/png' } })
    if (p === '/page.html')
      return new Response('<html>', { headers: { 'content-type': 'text/html' } })
    if (p === '/huge.png')
      return new Response(new Uint8Array(9 * 1024 * 1024), {
        headers: { 'content-type': 'image/png' },
      })
    return new Response('nf', { status: 404 })
  },
})
const base = `http://127.0.0.1:${host.port}`
const allow = [`${base}/images/`, `${base}/`]
const nikuOnly = [`${base}/images/`]
afterAll(() => host.stop(true))

describe('withImages', () => {
  test('text without images passes through untouched', async () => {
    expect(await withImages('just words', allow)).toEqual({ content: 'just words', files: [] })
  })

  test('a fetchable markdown image becomes an attachment and leaves the text', async () => {
    const r = await withImages(
      `![a sleepy cat](${base}/images/2026-10-06/cat.png)\n\nHere you go!`,
      nikuOnly,
    )
    expect(r.content).toBe('Here you go!')
    expect(r.files).toHaveLength(1)
    expect(r.files[0]?.name).toBe('cat.png')
    expect(r.files[0]?.description).toBe('a sleepy cat')
    expect(new Uint8Array(r.files[0]?.attachment as Buffer)).toEqual(PNG)
  })

  test('an image-only reply keeps no text', async () => {
    const r = await withImages(`![cat](${base}/images/2026-10-06/cat.png)`, nikuOnly)
    expect(r.content).toBe('')
    expect(r.files).toHaveLength(1)
  })

  test('anything that is not a reachable image stays as markdown', async () => {
    const text = `![x](${base}/missing.png) ![y](${base}/page.html) ![z](${base}/huge.png) ![w](./local.png)`
    const r = await withImages(text, allow)
    expect(r.content).toBe(text)
    expect(r.files).toEqual([])
  })

  test('only URLs under an allowed prefix are fetched; none allowed means off', async () => {
    const elsewhere = `![cat](${base}/images/2026-10-06/cat.png)`
    expect((await withImages(elsewhere, [`${base}/other/`])).files).toEqual([])
    expect((await withImages(elsewhere, [])).content).toBe(elsewhere)
  })
})
