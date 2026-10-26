import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
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

describe('withImages — workspace files', () => {
  let dir: string
  let outside: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'egirl-ws-'))
    await mkdir(join(dir, 'charts'), { recursive: true })
    await writeFile(join(dir, 'charts', 'run.png'), Buffer.from(PNG))
    await writeFile(join(dir, 'notes.txt'), 'not an image')
    outside = await mkdtemp(join(tmpdir(), 'egirl-out-'))
    await writeFile(join(outside, 'secret.png'), Buffer.from(PNG))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  test('a workspace-relative image is attached and leaves the text', async () => {
    const r = await withImages('![chart](charts/run.png)\n\nhere', [], dir)
    expect(r.content).toBe('here')
    expect(r.files).toHaveLength(1)
    expect(r.files[0]?.name).toBe('run.png')
    expect(r.files[0]?.description).toBe('chart')
    expect(new Uint8Array(r.files[0]?.attachment as Buffer)).toEqual(PNG)
  })

  test('an absolute path inside the workspace is attached', async () => {
    const r = await withImages(`![c](${join(dir, 'charts', 'run.png')})`, [], dir)
    expect(r.files).toHaveLength(1)
  })

  test('a file:// URI inside the workspace is attached', async () => {
    const url = pathToFileURL(join(dir, 'charts', 'run.png')).href
    const r = await withImages(`![c](${url})`, [], dir)
    expect(r.files).toHaveLength(1)
  })

  test('a path climbing out of the workspace is refused', async () => {
    const text = `![s](${relative(dir, join(outside, 'secret.png'))})`
    const r = await withImages(text, [], dir)
    expect(r.files).toEqual([])
    expect(r.content).toBe(text)
  })

  test('a symlink escaping the workspace is refused', async () => {
    await symlink(join(outside, 'secret.png'), join(dir, 'escape.png'))
    const r = await withImages('![e](escape.png)', [], dir)
    expect(r.files).toEqual([])
  })

  test('a non-image file is not attached', async () => {
    const text = '![n](notes.txt)'
    const r = await withImages(text, [], dir)
    expect(r.files).toEqual([])
    expect(r.content).toBe(text)
  })

  test('without a workspace dir, local paths stay as markdown', async () => {
    const text = '![c](charts/run.png)'
    expect((await withImages(text, [])).content).toBe(text)
  })
})
