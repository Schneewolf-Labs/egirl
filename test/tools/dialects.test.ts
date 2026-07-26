import { afterEach, describe, expect, test } from 'bun:test'
import { dialectNames, qwen35Dialect, setToolDialect, toolDialect } from '../../src/tools/dialects'

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read a file',
    parameters: {
      type: 'object' as const,
      properties: { path: { type: 'string' }, limit: { type: 'number' } },
      required: ['path'],
    },
  },
]

afterEach(() => {
  setToolDialect('auto')
})

describe('qwen35 dialect', () => {
  test('is registered and selectable', () => {
    expect(dialectNames()).toContain('qwen35')
    expect(setToolDialect('qwen35').name).toBe('qwen35')
    expect(toolDialect().name).toBe('qwen35')
  })

  test('asks in the model native format, not JSON-in-tool_call', () => {
    const section = qwen35Dialect.buildToolsSection(TOOLS)
    // the <function=>/<parameter=> shape is what Qwen3.5 was trained on
    expect(section).toContain('<function=example_function_name>')
    expect(section).toContain('<parameter=example_parameter_1>')
    expect(section).toContain('"name":"read_file"')
    // and must NOT teach the qwen3 JSON call form
    expect(section).not.toContain('return a json object with function name')
  })

  test('no tools means no section', () => {
    expect(qwen35Dialect.buildToolsSection(undefined)).toBe('')
    expect(qwen35Dialect.buildToolsSection([])).toBe('')
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

  test('tool results are wrapped in tool_response', () => {
    expect(qwen35Dialect.formatToolResponse('ok')).toBe('<tool_response>\nok\n</tool_response>')
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
