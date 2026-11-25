import { describe, expect, test } from 'bun:test'
import { createPasteBuffer } from '../../src/channels/cli-paste'

describe('paste buffer', () => {
  test('a line typed outside a paste goes straight through', () => {
    expect(createPasteBuffer().take('hello')).toBe('hello')
  })

  test('lines ending inside a paste are held, then sent with the next enter as one', () => {
    const p = createPasteBuffer()
    p.start()
    expect(p.take('Traceback:')).toBeUndefined()
    expect(p.take('  File "x.py"')).toBeUndefined()
    p.end()
    expect(p.held()).toBe(2)
    expect(p.take('ValueError: why?')).toBe('Traceback:\n  File "x.py"\nValueError: why?')
    expect(p.held()).toBe(0)
    expect(p.take('next')).toBe('next')
  })

  test('clear drops what was held', () => {
    const p = createPasteBuffer()
    p.start()
    p.take('a')
    p.end()
    p.clear()
    expect(p.take('b')).toBe('b')
  })
})
