import { describe, expect, test } from 'bun:test'
import { codexChoicePrompt } from '../../src/tools/builtin/code-agent/codex'

const trust =
  'Do you trust the contents of this directory?\r\n› 1. Yes, continue\r\n2. No, quit\r\nPress enter to continue'

describe('Codex prompts', () => {
  test('waits for the complete trust menu', () => {
    expect(codexChoicePrompt('Do you trust the contents of this directory?')).toBeUndefined()
    expect(codexChoicePrompt(trust)).toContain('trust the working directory')
  })

  test('does not replay a trust decision after the main prompt returns', () => {
    expect(codexChoicePrompt(`${trust}\r\n› Fix the player script\r\nWorking (1s)`)).toBeUndefined()
  })
})
