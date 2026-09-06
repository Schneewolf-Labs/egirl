import { describe, expect, test } from 'bun:test'
import {
  buildToolsSection,
  formatToolCall,
  formatToolResponse,
  hasToolCalls,
  parseToolCalls,
} from '../../src/tools/format'

describe('parseToolCalls', () => {
  test('parses single tool call', () => {
    const content = `Let me read that file.
<tool_call>
{"name": "read_file", "arguments": {"path": "/etc/hosts"}}
</tool_call>`

    const result = parseToolCalls(content)

    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].name).toBe('read_file')
    expect(result.toolCalls[0].arguments).toEqual({ path: '/etc/hosts' })
    expect(result.content).toBe('Let me read that file.')
  })

  test('parses multiple tool calls', () => {
    const content = `I'll check both files.
<tool_call>
{"name": "read_file", "arguments": {"path": "a.txt"}}
</tool_call>
<tool_call>
{"name": "read_file", "arguments": {"path": "b.txt"}}
</tool_call>`

    const result = parseToolCalls(content)

    expect(result.toolCalls).toHaveLength(2)
    expect(result.toolCalls[0].arguments).toEqual({ path: 'a.txt' })
    expect(result.toolCalls[1].arguments).toEqual({ path: 'b.txt' })
  })

  test('handles no tool calls', () => {
    const content = 'Just a regular response.'
    const result = parseToolCalls(content)

    expect(result.toolCalls).toHaveLength(0)
    expect(result.content).toBe('Just a regular response.')
  })

  test('handles malformed JSON', () => {
    const content = `<tool_call>
{not valid json}
</tool_call>`

    const result = parseToolCalls(content)
    expect(result.toolCalls).toHaveLength(0)
  })

  test('repairs unquoted name with dangling closing quote', () => {
    const content = `<tool_call>
{"name":code_agent", "arguments": {"task": "hi"}}
</tool_call>`

    const result = parseToolCalls(content)
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].name).toBe('code_agent')
    expect(result.toolCalls[0].arguments).toEqual({ task: 'hi' })
    expect(result.content).toBe('')
  })

  test('repairs fully unquoted name', () => {
    const content = `<tool_call>
{"name": glob_files, "arguments": {"dir": "/tmp", "pattern": "**/*"}}
</tool_call>`

    const result = parseToolCalls(content)
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].name).toBe('glob_files')
    expect(result.toolCalls[0].arguments).toEqual({ dir: '/tmp', pattern: '**/*' })
  })

  test('repairs name with dangling opening quote', () => {
    const content = `<tool_call>
{"name": "read_file, "arguments": {"path": "x"}}
</tool_call>`

    const result = parseToolCalls(content)
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].name).toBe('read_file')
  })

  test('repairs a dropped opening brace on the arguments object', () => {
    // B0-9B, verbatim: the `{` after "arguments": is missing, so the object is one level short.
    const content = `<tool_call>
{"name":"read_file","arguments":"path":"/home/nbeerbower/Projects/dummy/buchbinder/dedupe.py"}
</tool_call>
<tool_call>
{"name":"glob_files","arguments":"pattern":"**/test*dedupe*.py"}
</tool_call>`

    const result = parseToolCalls(content)
    expect(result.toolCalls).toHaveLength(2)
    expect(result.toolCalls[0].name).toBe('read_file')
    expect(result.toolCalls[0].arguments).toEqual({
      path: '/home/nbeerbower/Projects/dummy/buchbinder/dedupe.py',
    })
    expect(result.toolCalls[1].arguments).toEqual({ pattern: '**/test*dedupe*.py' })
    expect(result.content).toBe('')
  })

  test('repairs a call collapsed to NAME{...}', () => {
    // B1-9B, verbatim: no wrapper object, no "name" key, the identifier glued to the arguments.
    const content = `<tool_call>
read_file{"path":"/home/nbeerbower/Projects/dummy/buchbinder/dedupe.py"}
</tool_call>`

    const result = parseToolCalls(content)
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].name).toBe('read_file')
    expect(result.toolCalls[0].arguments).toEqual({
      path: '/home/nbeerbower/Projects/dummy/buchbinder/dedupe.py',
    })
    expect(result.content).toBe('')
  })

  test('does not turn prose followed by an object into a call', () => {
    const content = `<tool_call>
here is the config {"path": "x"}
</tool_call>`

    expect(parseToolCalls(content).toolCalls).toHaveLength(0)
  })

  test('assigns sequential call IDs', () => {
    const content = `<tool_call>
{"name": "a", "arguments": {}}
</tool_call>
<tool_call>
{"name": "b", "arguments": {}}
</tool_call>`

    const result = parseToolCalls(content)
    expect(result.toolCalls[0].id).toBe('call_0')
    expect(result.toolCalls[1].id).toBe('call_1')
  })
})

describe('formatToolCall', () => {
  test('formats tool call correctly', () => {
    const result = formatToolCall('read_file', { path: '/etc/hosts' })
    expect(result).toBe(
      '<tool_call>\n{"name":"read_file","arguments":{"path":"/etc/hosts"}}\n</tool_call>',
    )
  })
})

describe('formatToolResponse', () => {
  test('wraps output in tool_response tags', () => {
    const result = formatToolResponse('file contents here')
    expect(result).toBe('<tool_response>\nfile contents here\n</tool_response>')
  })
})

describe('buildToolsSection', () => {
  test('returns empty string for no tools', () => {
    expect(buildToolsSection([])).toBe('')
    expect(buildToolsSection(undefined)).toBe('')
  })

  test('formats tools section correctly', () => {
    const tools = [
      {
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ]

    const result = buildToolsSection(tools)

    expect(result).toContain('# Tools')
    expect(result).toContain('<tools>')
    expect(result).toContain('</tools>')
    expect(result).toContain('"name":"read_file"')
    expect(result).toContain('<tool_call>')
  })
})

describe('hasToolCalls', () => {
  test('returns true when tool calls present', () => {
    expect(hasToolCalls('<tool_call>{"name":"x"}</tool_call>')).toBe(true)
  })

  test('returns false when no tool calls', () => {
    expect(hasToolCalls('just text')).toBe(false)
  })
})
