import type { ToolCall } from '../providers/types'
import type { ToolDefinition } from './types'

/**
 * Tool-calling dialects.
 *
 * A local model emits tool calls in whatever syntax it was trained on, and the syntax we
 * ASK for has to match the syntax we PARSE — otherwise the model answers correctly in its
 * own dialect and the loop throws the calls away. (Laguna did exactly that: four correct
 * tool calls on its first turn, zero parsed, run over after one turn.)
 *
 * So rendering and parsing live together in one object per dialect, chosen by
 * `[local] tool_format` in egirl.toml. Adding a model family means adding a dialect here,
 * not patching a regex.
 */
export interface ToolDialect {
  name: string
  /** tool definitions block appended to the system prompt */
  buildToolsSection(tools: ToolDefinition[] | undefined): string
  /** pull tool calls out of assistant output, returning the text with them removed */
  parseToolCalls(content: string): { content: string; toolCalls: ToolCall[] }
  /** render one tool result back to the model */
  formatToolResponse(output: string): string
}

function toolSignature(tool: ToolDefinition): object {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }
}

/** Values arrive as text. Numbers/bools/objects should reach tools as themselves. */
function coerceArgValue(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed === '') return raw
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null') return null
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return raw
    }
  }
  return raw
}

const KV_CALL_RE = /<tool_call>([\s\S]*?)<\/tool_call>/g
const KV_ARG_RE = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g

/**
 * Split content into the chunks that follow each <tool_call> opener.
 *
 * Deliberately lenient about the closer. A local model with imperfect format adherence
 * emits things like two openers and one closer, or drops the closer entirely at the end of
 * a message; a strict `<tool_call>...</tool_call>` match then yields zero calls and the
 * agent loop stalls with the model's intent visible but unusable. A chunk therefore ends at
 * the first of: its closer, the next opener, or end of content.
 */
function toolCallChunks(content: string): { chunk: string; raw: string }[] {
  const out: { chunk: string; raw: string }[] = []
  const OPEN = '<tool_call>'
  const CLOSE = '</tool_call>'
  let i = content.indexOf(OPEN)
  while (i !== -1) {
    const bodyStart = i + OPEN.length
    const close = content.indexOf(CLOSE, bodyStart)
    const nextOpen = content.indexOf(OPEN, bodyStart)
    let end: number
    let rawEnd: number
    if (close !== -1 && (nextOpen === -1 || close < nextOpen)) {
      end = close
      rawEnd = close + CLOSE.length
    } else if (nextOpen !== -1) {
      end = nextOpen
      rawEnd = nextOpen
    } else {
      end = content.length
      rawEnd = content.length
    }
    out.push({ chunk: content.slice(bodyStart, end), raw: content.slice(i, rawEnd) })
    i = content.indexOf(OPEN, rawEnd === i ? i + OPEN.length : rawEnd)
  }
  return out
}

/** Every balanced {...} object in a string, ignoring braces inside string literals. */
function jsonObjects(text: string): string[] {
  const objs: string[] = []
  let depth = 0
  let start = -1
  let inStr = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && start !== -1) {
        objs.push(text.slice(start, i + 1))
        start = -1
      }
      if (depth < 0) depth = 0
    }
  }
  return objs
}

/**
 * JSON tool calls, accepting the shapes models actually produce:
 *   {"name": n, "arguments": {...}}   the documented form
 *   {"name": n, "path": "..."}        arguments flattened to top level
 * and several objects inside one <tool_call> block.
 */
export function parseJsonToolCalls(content: string): {
  content: string
  toolCalls: Omit<ToolCall, 'id'>[]
} {
  const toolCalls: Omit<ToolCall, 'id'>[] = []
  let cleanContent = content

  for (const { chunk, raw } of toolCallChunks(content)) {
    let matched = false
    for (const objText of jsonObjects(chunk)) {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(objText) as Record<string, unknown>
      } catch {
        continue
      }
      const name = parsed.name
      if (typeof name !== 'string') continue
      let args: Record<string, unknown>
      if (parsed.arguments && typeof parsed.arguments === 'object') {
        args = parsed.arguments as Record<string, unknown>
      } else {
        // flattened: every key except the call's own metadata is an argument
        const { name: _n, arguments: _a, ...rest } = parsed
        args = rest
      }
      toolCalls.push({ name, arguments: args })
      matched = true
    }
    if (matched) cleanContent = cleanContent.replace(raw, '')
  }

  return { content: cleanContent, toolCalls }
}

/**
 * <tool_call>NAME<arg_key>k</arg_key><arg_value>v</arg_value></tool_call>
 * This is Laguna's native form, per its own chat_template.jinja: string values are raw,
 * non-strings are JSON — hence coerceArgValue rather than treating everything as text.
 */
export function parseKeyValueToolCalls(content: string): {
  content: string
  toolCalls: Omit<ToolCall, 'id'>[]
} {
  const toolCalls: Omit<ToolCall, 'id'>[] = []
  let cleanContent = content
  KV_CALL_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = KV_CALL_RE.exec(content)) !== null) {
    const inner = match[1]
    if (!inner || !inner.includes('<arg_key>')) continue
    const nameMatch = inner.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)/)
    if (!nameMatch?.[1]) continue

    const args: Record<string, unknown> = {}
    KV_ARG_RE.lastIndex = 0
    let argMatch: RegExpExecArray | null
    while ((argMatch = KV_ARG_RE.exec(inner)) !== null) {
      const key = argMatch[1]?.trim()
      if (key) args[key] = coerceArgValue(argMatch[2] ?? '')
    }
    toolCalls.push({ name: nameMatch[1], arguments: args })
    cleanContent = cleanContent.replace(match[0], '')
  }
  return { content: cleanContent, toolCalls }
}

function withIds(parsed: { content: string; toolCalls: Omit<ToolCall, 'id'>[] }): {
  content: string
  toolCalls: ToolCall[]
} {
  return {
    content: parsed.content.trim(),
    toolCalls: parsed.toolCalls.map((c, i) => ({ ...c, id: `call_${i}` })),
  }
}

const QWEN3_INSTRUCTION = `# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
{definitions}
</tools>

For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:
<tool_call>
{"name": "<function-name>", "arguments": <args-json-object>}
</tool_call>`

export const qwen3Dialect: ToolDialect = {
  name: 'qwen3',
  buildToolsSection(tools) {
    if (!tools || tools.length === 0) return ''
    const definitions = tools.map((t) => JSON.stringify(toolSignature(t))).join('\n')
    return `\n\n${QWEN3_INSTRUCTION.replace('{definitions}', definitions)}`
  },
  parseToolCalls(content) {
    return withIds(parseJsonToolCalls(content))
  },
  formatToolResponse(output) {
    return `<tool_response>\n${output}\n</tool_response>`
  },
}

/** Mirrors Laguna's chat template: <available_tools> for signatures, arg_key/arg_value calls. */
export const lagunaDialect: ToolDialect = {
  name: 'laguna',
  buildToolsSection(tools) {
    if (!tools || tools.length === 0) return ''
    const definitions = tools.map((t) => JSON.stringify(toolSignature(t))).join('\n')
    return [
      '\n\n### Tools\n',
      'You may call functions to assist with the user query.\n',
      'All available function signatures are listed below:\n',
      '<available_tools>\n',
      `${definitions}\n`,
      '</available_tools>\n\n',
      'For each function call, emit:\n',
      '<tool_call>function_name<arg_key>argument_name</arg_key><arg_value>value</arg_value></tool_call>',
    ].join('')
  },
  parseToolCalls(content) {
    // Accept the JSON form too: asking for one dialect does not stop a model reaching
    // for the other, and a parsed call is always better than a stranded one.
    const kv = parseKeyValueToolCalls(content)
    if (kv.toolCalls.length > 0) return withIds(kv)
    return withIds(parseJsonToolCalls(content))
  },
  formatToolResponse(output) {
    return `<tool_response>${output}</tool_response>`
  },
}

/** Ask in Qwen3 form (widely understood), accept either on the way back. */
export const autoDialect: ToolDialect = {
  name: 'auto',
  buildToolsSection: qwen3Dialect.buildToolsSection,
  parseToolCalls(content) {
    const json = parseJsonToolCalls(content)
    if (json.toolCalls.length > 0) return withIds(json)
    return withIds(parseKeyValueToolCalls(content))
  },
  formatToolResponse: qwen3Dialect.formatToolResponse,
}

const DIALECTS: Record<string, ToolDialect> = {
  auto: autoDialect,
  qwen3: qwen3Dialect,
  laguna: lagunaDialect,
}

export function dialectNames(): string[] {
  return Object.keys(DIALECTS)
}

let active: ToolDialect = autoDialect

/** Select the dialect for this process (from `[local] tool_format`). */
export function setToolDialect(name: string | undefined): ToolDialect {
  const chosen = name ? DIALECTS[name] : undefined
  active = chosen ?? autoDialect
  return active
}

export function toolDialect(): ToolDialect {
  return active
}
