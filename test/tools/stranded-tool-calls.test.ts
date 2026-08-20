/**
 * Tool calls a quantized model mangled on its way out.
 *
 * When a call fails to parse, the markup stays in the content and the turn ends -- so the
 * model appears to think, call a tool, and stop, with raw XML printed as its answer and the
 * action silently discarded. These cover the specific malformation seen in the wild and the
 * general detection that lets the loop ask for a reissue instead of giving up.
 */

import { describe, expect, test } from 'bun:test'
import { parseJsonToolCalls } from '../../src/tools/dialects'
import { hasStrandedToolCall, hasToolCalls, stripStrandedToolCalls } from '../../src/tools/format'

describe('doubled brace-quote before the first argument', () => {
  // Emitted verbatim by huihui-qwen3.8-27b-q8 on a ~113k-token context: the call is correct
  // apart from two characters, and every one of them was being thrown away.
  const mangled = `<tool_call>
{"name":"execute_command","arguments":{"{"command": "cd /home/zero/.egirl/personas/zero/lego_loco && ls && ls game/ 2>/dev/null | head && du -sh game 2>/dev/null"}}
</tool_call>`

  test('the call is recovered', () => {
    const { toolCalls } = parseJsonToolCalls(mangled)
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]?.name).toBe('execute_command')
  })

  test('the arguments survive intact', () => {
    // Recovering a call with a truncated command would be worse than not recovering it.
    const { toolCalls } = parseJsonToolCalls(mangled)
    expect(toolCalls[0]?.arguments.command).toBe(
      'cd /home/zero/.egirl/personas/zero/lego_loco && ls && ls game/ 2>/dev/null | head && du -sh game 2>/dev/null',
    )
  })

  test('the markup is stripped from the content', () => {
    // What is left is what the user sees; raw XML there is the visible symptom.
    expect(parseJsonToolCalls(mangled).content.trim()).toBe('')
  })

  test('an object legitimately keyed on a brace is left alone', () => {
    const keyed = `<tool_call>{"name":"f","arguments":{"{": "value"}}</tool_call>`
    expect(parseJsonToolCalls(keyed).toolCalls[0]?.arguments).toEqual({ '{': 'value' })
  })
})

describe('hasStrandedToolCall', () => {
  test('markup that produced no call is stranded', () => {
    // Unrecoverable by any repair: no name at all.
    const junk = '<tool_call>\n{"nmae": ???}\n</tool_call>'
    expect(hasToolCalls(junk)).toBe(false)
    expect(hasStrandedToolCall(junk)).toBe(true)
  })

  test('a call that parses is not stranded', () => {
    const good = '<tool_call>\n{"name":"read_file","arguments":{"path":"a.txt"}}\n</tool_call>'
    expect(hasStrandedToolCall(good)).toBe(false)
  })

  test('ordinary prose is not stranded', () => {
    // The distinction the loop depends on: prose is an answer and must end the turn.
    expect(hasStrandedToolCall('Here is where we left off: the parser was wrong.')).toBe(false)
  })

  test('prose that merely mentions tool calls is not stranded', () => {
    expect(hasStrandedToolCall('I could not emit a valid tool call for that.')).toBe(false)
  })
})

describe('missing name key', () => {
  // Emitted verbatim by Zero (huihui-qwen3.8-q8) on 2026-08-20, persistently enough that
  // three reissue nudges could not shake it: the "name": key dropped, bare value first.
  const nameless = `<tool_call>\n{"execute_command", "arguments": {"command": "find /home/zero/.egirl -maxdepth 3 | head -80"}}\n</tool_call>`

  test('the call is recovered with its name and arguments', () => {
    const { toolCalls } = parseJsonToolCalls(nameless)
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]?.name).toBe('execute_command')
    expect(toolCalls[0]?.arguments.command).toBe('find /home/zero/.egirl -maxdepth 3 | head -80')
  })

  test('a mangled ARGUMENT object is never rewritten into a call name', () => {
    // The same malformation inside arguments must not invent {"name":"command"...}: the
    // repair is anchored on a following "arguments" key, which this does not have.
    const argMangled = `<tool_call>\n{"name":"noop","arguments":{"command", "ls"}}\n</tool_call>`
    const { toolCalls } = parseJsonToolCalls(argMangled)
    expect(toolCalls.filter((c) => c.name === 'command')).toHaveLength(0)
  })
})

describe('stripStrandedToolCalls', () => {
  test('unparseable markup is replaced with an honest note', () => {
    const junk = 'I will check.\n<tool_call>\n{"nmae": ???}\n</tool_call>'
    const out = stripStrandedToolCalls(junk)
    expect(out).toContain('I will check.')
    expect(out).toContain('failed to parse')
    expect(out).not.toContain('<tool_call>')
    expect(out).not.toContain('nmae')
  })

  test('an unclosed block at end of content is stripped too', () => {
    const out = stripStrandedToolCalls('half a call: <tool_call>\n{"broken')
    expect(out).not.toContain('{"broken')
  })
})
