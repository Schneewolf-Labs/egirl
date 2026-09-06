import { afterEach, describe, expect, test } from 'bun:test'
import {
  deepseekDialect,
  dialectNames,
  qwen35Dialect,
  setToolDialect,
  toolDialect,
} from '../../src/tools/dialects'

afterEach(() => {
  setToolDialect('auto')
})

describe('qwen35 dialect', () => {
  test('is registered and selectable', () => {
    expect(dialectNames()).toContain('qwen35')
    expect(setToolDialect('qwen35').name).toBe('qwen35')
    expect(toolDialect().name).toBe('qwen35')
  })

  test('parses a native call and coerces argument types', () => {
    const content = `I'll read it.
<tool_call>
<function=read_file>
<parameter=path>
/etc/hosts
</parameter>
<parameter=limit>
20
</parameter>
</function>
</tool_call>`
    const r = qwen35Dialect.parseToolCalls(content)
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0]!.name).toBe('read_file')
    expect(r.toolCalls[0]!.arguments).toEqual({ path: '/etc/hosts', limit: 20 })
    expect(r.content).toBe("I'll read it.")
    expect(r.toolCalls[0]!.id).toBeTruthy()
  })

  test('parses two calls in one reply', () => {
    const content =
      '<tool_call>\n<function=a>\n<parameter=x>\n1\n</parameter>\n</function>\n</tool_call>\n' +
      '<tool_call>\n<function=b>\n<parameter=y>\n2\n</parameter>\n</function>\n</tool_call>'
    const r = qwen35Dialect.parseToolCalls(content)
    expect(r.toolCalls.map((c) => c.name)).toEqual(['a', 'b'])
  })

  test('keeps multi-line values intact — the closing tag ends a value, not a newline', () => {
    const content = `<tool_call>
<function=write_file>
<parameter=content>
line one
line two

line four
</parameter>
</function>
</tool_call>`
    const r = qwen35Dialect.parseToolCalls(content)
    expect(r.toolCalls[0]!.arguments).toEqual({ content: 'line one\nline two\n\nline four' })
  })

  test('falls back to the JSON form when the model reaches for another dialect', () => {
    const content =
      '<tool_call>\n{"name": "read_file", "arguments": {"path": "/tmp/x"}}\n</tool_call>'
    const r = qwen35Dialect.parseToolCalls(content)
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0]!.name).toBe('read_file')
  })

  test('plain prose yields no calls', () => {
    const r = qwen35Dialect.parseToolCalls('Just answering normally.')
    expect(r.toolCalls).toHaveLength(0)
    expect(r.content).toBe('Just answering normally.')
  })
})

describe('deepseek dialect', () => {
  test('is registered and selectable', () => {
    expect(dialectNames()).toContain('deepseek')
    expect(setToolDialect('deepseek').name).toBe('deepseek')
    expect(toolDialect().name).toBe('deepseek')
  })

  test('parses the native DSML opener with a full-width bar', () => {
    // captured from a real DeepSeek v4 turn: native token instead of the ASCII <tool_call>.
    const r = deepseekDialect.parseToolCalls(
      '<｜DSML｜tool_call>\n{"name": "read_file", "arguments": {"path": "/etc/hosts"}}',
    )
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0]!.name).toBe('read_file')
    expect(r.toolCalls[0]!.arguments).toEqual({ path: '/etc/hosts' })
    expect(r.content).not.toContain('DSML')
    expect(r.content).not.toContain('tool_call')
  })

  test('collapses the doubled-opener quirk to one call', () => {
    // DeepSeek under load doubles the opener for a single call, and the argument value can be
    // a multiline heredoc — exactly the shape captured from Zero's session.
    const raw =
      '<｜DSML｜tool_call>\n<｜DSML｜tool_call>\n' +
      '{"name":"execute_command","arguments":{"command":"cat >> NOTES.md << \'EOF\'\\n## CHECKPOINT\\nline two\\nEOF"}}'
    const r = deepseekDialect.parseToolCalls(raw)
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0]!.name).toBe('execute_command')
    expect(r.toolCalls[0]!.arguments.command).toContain('## CHECKPOINT')
    expect(r.content).not.toContain('tool_call')
  })

  test('still accepts the compliant ASCII form on a clean turn', () => {
    const r = deepseekDialect.parseToolCalls(
      'Reading it now.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "/tmp/a"}}\n</tool_call>',
    )
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0]!.arguments).toEqual({ path: '/tmp/a' })
  })

  test('two genuine back-to-back calls are not merged', () => {
    const raw =
      '<｜DSML｜tool_call>\n{"name":"read_file","arguments":{"path":"/a"}}\n</tool_call>\n' +
      '<｜DSML｜tool_call>\n{"name":"read_file","arguments":{"path":"/b"}}\n</tool_call>'
    const r = deepseekDialect.parseToolCalls(raw)
    expect(r.toolCalls).toHaveLength(2)
    expect(r.toolCalls.map((c) => c.arguments.path)).toEqual(['/a', '/b'])
  })
})

describe('auto dialect', () => {
  test('also accepts the qwen35 native form', () => {
    const d = setToolDialect('auto')
    const r = d.parseToolCalls(
      '<tool_call>\n<function=read_file>\n<parameter=path>\n/tmp/a\n</parameter>\n</function>\n</tool_call>',
    )
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0]!.arguments).toEqual({ path: '/tmp/a' })
  })
})

describe('split name/arguments emission', () => {
  test('marries an orphan arguments object to its argless call in the same chunk', () => {
    // Observed from a q8 27B under long context: the name and the arguments arrive as two
    // separate JSON objects inside one <tool_call> block. The arguments were being dropped.
    const d = setToolDialect('auto')
    const r = d.parseToolCalls(
      '<tool_call>\n{"name": "execute_command"}\n{"command": "ls /tmp"}\n</tool_call>',
    )
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0]?.arguments).toEqual({ command: 'ls /tmp' })
  })

  test('does not marry when the pairing is ambiguous', () => {
    const d = setToolDialect('auto')
    const r = d.parseToolCalls(
      '<tool_call>\n{"name": "execute_command"}\n{"command": "a"}\n{"command": "b"}\n</tool_call>',
    )
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0]?.arguments).toEqual({})
  })

  test('a call that already has arguments is left alone', () => {
    const d = setToolDialect('auto')
    const r = d.parseToolCalls(
      '<tool_call>\n{"name": "execute_command", "arguments": {"command": "pwd"}}\n{"stray": true}\n</tool_call>',
    )
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0]?.arguments).toEqual({ command: 'pwd' })
  })
})
