import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createScreen, type Screen } from '../../src/channels/cli-screen'

const UP = '\x1b[1A\x1b[2K'

describe('createScreen', () => {
  const realWrite = process.stdout.write
  const realErr = process.stderr.write
  let written: string[]
  let screen: Screen | undefined

  beforeEach(() => {
    written = []
    process.stdout.write = ((chunk: unknown) => {
      written.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    process.stderr.write = ((chunk: unknown) => {
      written.push(`ERR:${String(chunk)}`)
      return true
    }) as typeof process.stderr.write
  })

  afterEach(() => {
    screen?.restore()
    screen = undefined
    process.stdout.write = realWrite
    process.stderr.write = realErr
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

  test('a log line during a streaming reply waits for the reply line to end', () => {
    screen = createScreen(() => {})
    process.stdout.write('It was **three')
    process.stderr.write('[05:07] INFO summary\n')
    expect(written).toEqual(['It was **three'])
    process.stdout.write(' loops**\n')
    expect(written).toEqual(['It was **three', ' loops**\n', 'ERR:[05:07] INFO summary\n'])
  })

  test('a log line between reply lines is written at once', () => {
    screen = createScreen(() => {})
    process.stdout.write('done\n')
    process.stderr.write('log\n')
    expect(written).toEqual(['done\n', 'ERR:log\n'])
  })

  test('restore writes held logs on a row of their own', () => {
    screen = createScreen(() => {})
    process.stdout.write('half')
    process.stderr.write('log\n')
    screen.restore()
    screen = undefined
    expect(written).toEqual(['half', '\n', 'ERR:log\n'])
  })
})
