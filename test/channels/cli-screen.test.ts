import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createScreen, type Screen } from '../../src/channels/cli-screen'

const UP = '\x1b[1A\x1b[2K'

describe('createScreen', () => {
  const realWrite = process.stdout.write
  let written: string[]
  let screen: Screen | undefined

  beforeEach(() => {
    written = []
    process.stdout.write = ((chunk: unknown) => {
      written.push(String(chunk))
      return true
    }) as typeof process.stdout.write
  })

  afterEach(() => {
    screen?.restore()
    screen = undefined
    process.stdout.write = realWrite
  })

  test('draws pinned rows above the input row', () => {
    screen = createScreen(() => {})
    screen.draw('> hi', ['status'])
    expect(written.join('')).toBe('\r\x1b[2Kstatus\n> hi')
  })

  test('output erases every live row before it is written', () => {
    screen = createScreen(() => {})
    screen.draw('> hi', ['status'])
    written = []
    process.stdout.write('reply\n')
    expect(written).toEqual([`\r\x1b[2K${UP}`, 'reply\n'])
  })

  test('a redraw clears the rows it drew last time, in the same write', () => {
    screen = createScreen(() => {})
    screen.draw('> hi', ['status'])
    written = []
    screen.draw('> hi')
    expect(written).toEqual([`\r\x1b[2K${UP}\r\x1b[2K> hi`])
    written = []
    screen.draw('> hi!')
    expect(written).toEqual(['\r\x1b[2K\r\x1b[2K> hi!'])
  })

  test('restore erases the whole live area', () => {
    screen = createScreen(() => {})
    screen.draw('> hi', ['a', 'b'])
    written = []
    screen.restore()
    screen = undefined
    expect(written).toEqual([`\r\x1b[2K${UP}${UP}`])
  })
})
