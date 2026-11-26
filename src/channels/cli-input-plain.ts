/**
 * The CLI's input without a terminal: stdin piped or redirected. Lines are read and handed on;
 * there is no live line, so nothing is drawn.
 */

import * as readline from 'node:readline'
import type { CLIInput, CLIInputHooks } from './cli-input'

export function createPlainInput(hooks: CLIInputHooks): CLIInput {
  let asking: ((line: string) => void) | undefined
  let closed = false
  const rl = readline.createInterface({ input: process.stdin, terminal: false })
  rl.on('line', (line) => {
    if (asking) {
      const resolve = asking
      asking = undefined
      resolve(line)
      return
    }
    hooks.onLine(line)
  })
  rl.on('close', () => {
    closed = true
    hooks.onClose()
  })
  return {
    isInteractive: false,
    setPrompt() {},
    setStatus() {},
    suggest() {},
    notice: (text) => console.log(text),
    ask(question) {
      process.stdout.write(`${question}\n`)
      return new Promise((resolve) => {
        asking = resolve
      })
    },
    close() {
      if (closed) return
      closed = true
      rl.close()
    },
  }
}
