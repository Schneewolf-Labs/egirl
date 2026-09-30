import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  attachmentNote,
  attachmentsDir,
  resolveImageRefs,
  saveImageAttachments,
} from '../../src/agent/attachments'

const PNG = `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`
const JPEG = `data:image/jpeg;base64,${Buffer.from('jpeg-bytes').toString('base64')}`

describe('saveImageAttachments', () => {
  test('writes each image under the session folder with a numbered handle', () => {
    const ws = mkdtempSync(join(tmpdir(), 'egirl-att-'))
    const saved = saveImageAttachments(ws, 'api:abc', [PNG, JPEG])
    expect(saved.map((s) => s.handle)).toEqual(['img1', 'img2'])
    expect(saved[0]?.path.startsWith(attachmentsDir(ws, 'api:abc'))).toBe(true)
    expect(saved[1]?.path.endsWith('.jpg')).toBe(true)
    expect(readFileSync(saved[0]?.path as string, 'utf8')).toBe('png-bytes')
  })

  test('handles keep counting across messages in one session', () => {
    const ws = mkdtempSync(join(tmpdir(), 'egirl-att-'))
    saveImageAttachments(ws, 's', [PNG])
    const second = saveImageAttachments(ws, 's', [PNG])
    expect(second[0]?.handle).toBe('img2')
  })

  test('skips anything that is not a base64 image data URL', () => {
    const ws = mkdtempSync(join(tmpdir(), 'egirl-att-'))
    const saved = saveImageAttachments(ws, 's', ['https://example.com/a.png', PNG])
    expect(saved.map((s) => s.handle)).toEqual(['img1'])
  })

  test("prunes other sessions' folders older than a week", () => {
    const ws = mkdtempSync(join(tmpdir(), 'egirl-att-'))
    const old = attachmentsDir(ws, 'old')
    mkdirSync(old, { recursive: true })
    const weekAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000
    utimesSync(old, weekAgo, weekAgo)
    saveImageAttachments(ws, 'new', [PNG])
    expect(existsSync(old)).toBe(false)
  })
})

describe('attachmentNote', () => {
  test('names each handle and path', () => {
    expect(attachmentNote([{ handle: 'img1', path: '/w/a.png' }])).toBe(
      '[Attached images, saved for handing on: img1 = /w/a.png]',
    )
    expect(attachmentNote([])).toBe('')
  })
})

describe('resolveImageRefs', () => {
  test('resolves handles within the session and plain paths', () => {
    const ws = mkdtempSync(join(tmpdir(), 'egirl-att-'))
    const [first] = saveImageAttachments(ws, 's', [PNG])
    const shot = join(ws, 'shot.png')
    writeFileSync(shot, 'x')
    const { paths, missing } = resolveImageRefs(['img1', shot, 'img1'], ws, 's')
    expect(paths).toEqual([first?.path as string, shot])
    expect(missing).toEqual([])
  })

  test('reports unknown handles, other sessions, and non-image files as missing', () => {
    const ws = mkdtempSync(join(tmpdir(), 'egirl-att-'))
    saveImageAttachments(ws, 'other', [PNG])
    writeFileSync(join(ws, 'notes.md'), 'x')
    const { paths, missing } = resolveImageRefs(['img1', 'notes.md', '/nope.png'], ws, 's')
    expect(paths).toEqual([])
    expect(missing).toEqual(['img1', 'notes.md', '/nope.png'])
  })
})
