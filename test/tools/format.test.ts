import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { setToolDialect } from '../../src/tools/dialects'
import { hasToolCalls, parseToolCalls } from '../../src/tools/format'

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

describe('hasToolCalls', () => {
  test('returns true when tool calls present', () => {
    expect(hasToolCalls('<tool_call>{"name":"x"}</tool_call>')).toBe(true)
  })

  test('returns false when no tool calls', () => {
    expect(hasToolCalls('just text')).toBe(false)
  })
})

// DeepSeek-V4's native invoke/parameter form. Fixtures are from deepseek-ai/DeepSeek-V4-Flash
// encoding/: the first two verbatim from tests/test_output_1.txt and test_output_3.txt, the rest
// rendered by encoding_dsv4.py's encode_messages (no gold file carries string="false" or several
// invokes in one block).
describe('parseToolCalls (deepseek DSML invoke form)', () => {
  beforeEach(() => {
    setToolDialect('deepseek')
  })
  afterEach(() => {
    setToolDialect('auto')
  })

  test('parses the gold get_weather call from test_output_1.txt', () => {
    const content = `<｜DSML｜tool_calls>
<｜DSML｜invoke name="get_weather">
<｜DSML｜parameter name="location" string="true">Beijing</｜DSML｜parameter>
<｜DSML｜parameter name="unit" string="true">celsius</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>`

    const result = parseToolCalls(content)
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].name).toBe('get_weather')
    expect(result.toolCalls[0].arguments).toEqual({ location: 'Beijing', unit: 'celsius' })
    expect(result.content).toBe('')
  })

  test('keeps surrounding text and non-ASCII values (test_output_3.txt)', () => {
    const content = `Let me look that up.

<｜DSML｜tool_calls>
<｜DSML｜invoke name="search">
<｜DSML｜parameter name="queries" string="true">小柴胡冲剂 布洛芬 相互作用 一起吃</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>`

    const result = parseToolCalls(content)
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].name).toBe('search')
    expect(result.toolCalls[0].arguments).toEqual({ queries: '小柴胡冲剂 布洛芬 相互作用 一起吃' })
    expect(result.content).toBe('Let me look that up.')
  })

  test('parses multiple invokes with string and JSON params and a multi-line value', () => {
    const content = `<｜DSML｜tool_calls>
<｜DSML｜invoke name="search">
<｜DSML｜parameter name="query" string="true">weather in Beijing</｜DSML｜parameter>
<｜DSML｜parameter name="num_results" string="false">5</｜DSML｜parameter>
</｜DSML｜invoke>
<｜DSML｜invoke name="open">
<｜DSML｜parameter name="open_list" string="false">[{"id": "https://example.com", "loc": -1, "view_source": false}]</｜DSML｜parameter>
</｜DSML｜invoke>
<｜DSML｜invoke name="write_file">
<｜DSML｜parameter name="path" string="true">notes.md</｜DSML｜parameter>
<｜DSML｜parameter name="content" string="true">line one
line two

  indented</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>`

    const result = parseToolCalls(content)
    expect(result.toolCalls.map((c) => c.name)).toEqual(['search', 'open', 'write_file'])
    expect(result.toolCalls[0].arguments).toEqual({ query: 'weather in Beijing', num_results: 5 })
    expect(result.toolCalls[1].arguments).toEqual({
      open_list: [{ id: 'https://example.com', loc: -1, view_source: false }],
    })
    expect(result.toolCalls[2].arguments).toEqual({
      path: 'notes.md',
      content: 'line one\nline two\n\n  indented',
    })
    expect(result.toolCalls.map((c) => c.id)).toEqual(['call_0', 'call_1', 'call_2'])
    expect(result.content).toBe('')
  })

  test('string="true" keeps JSON-looking text as a string', () => {
    const content = `<｜DSML｜tool_calls>
<｜DSML｜invoke name="search">
<｜DSML｜parameter name="query" string="true">42</｜DSML｜parameter>
<｜DSML｜parameter name="filter" string="true">{"a": 1}</｜DSML｜parameter>
<｜DSML｜parameter name="strict" string="false">true</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>`

    const result = parseToolCalls(content)
    expect(result.toolCalls[0].arguments).toEqual({ query: '42', filter: '{"a": 1}', strict: true })
  })

  test('recovers a call whose closers were cut off', () => {
    const content = `<｜DSML｜tool_calls>
<｜DSML｜invoke name="get_weather">
<｜DSML｜parameter name="location" string="true">Beijing</｜DSML｜parameter>
<｜DSML｜parameter name="unit" string="true">celsius`

    const result = parseToolCalls(content)
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].arguments).toEqual({ location: 'Beijing', unit: 'celsius' })
    expect(result.content).toBe('')
  })

  test('a missing invoke closer does not swallow the next invoke', () => {
    const content = `<｜DSML｜tool_calls>
<｜DSML｜invoke name="read_file">
<｜DSML｜parameter name="path" string="true">/a</｜DSML｜parameter>
<｜DSML｜invoke name="read_file">
<｜DSML｜parameter name="path" string="true">/b</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>`

    const result = parseToolCalls(content)
    expect(result.toolCalls.map((c) => c.arguments.path)).toEqual(['/a', '/b'])
    expect(result.content).toBe('')
  })

  test('still parses the JSON-bodied DSML opener', () => {
    const result = parseToolCalls(
      '<｜DSML｜tool_call>\n{"name": "read_file", "arguments": {"path": "/etc/hosts"}}',
    )
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].arguments).toEqual({ path: '/etc/hosts' })
  })
})
