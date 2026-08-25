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
/**
 * JSON.parse, then two repairs for quantization-mangled output, restoring behaviour that the
 * dialect refactor dropped (see test/tools/format.test.ts "repairs ..." cases):
 *  1. single quotes used as JSON delimiters, without touching apostrophes inside strings;
 *  2. a tool name missing either or both of its quotes -- `"name":foo`, `"name":foo"`,
 *     `"name":"foo` -- which is by far the most common way a small quantized model breaks
 *     a call, and the one place a repair is safe because the key is known and the value is
 *     a bare identifier.
 */
const NAME_QUOTE_RE = /"name"\s*:\s*"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*([,}])/

/**
 * A doubled brace-quote before the first key -- `{"{"command": "ls"}` for `{"command": "ls"}`.
 * The lookahead spares a legitimate object keyed on `{`, which would be `{"{":`.
 */
const BRACE_DUP_RE = /\{\s*"\{"(?!\s*:)/g

/**
 * The name KEY dropped entirely -- `{"execute_command", "arguments": {...}}` for
 * `{"name": "execute_command", "arguments": {...}}`. Observed from the same q8 27B under
 * context pressure, persistently enough that three reissue nudges could not shake it.
 * Anchored on the following "arguments" key, so a mangled *argument* object (`{"command",
 * "ls"}`) can never be rewritten into a fake call name.
 */
const BARE_NAME_RE = /\{\s*"([a-zA-Z_][a-zA-Z0-9_]*)"\s*,\s*(?="arguments"\s*:)/g

function parseCallObject(jsonStr: string): Record<string, unknown> | undefined {
  const attempt = (text: string): Record<string, unknown> | undefined => {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      return parsed && typeof parsed.name === 'string' ? parsed : undefined
    } catch {
      return undefined
    }
  }
  const direct = attempt(jsonStr)
  if (direct) return direct

  const singleQuoted = attempt(
    jsonStr.replace(/(\{|,)\s*'(\w+)'\s*:/g, '$1 "$2":').replace(/:\s*'([^']*)'/g, ': "$1"'),
  )
  if (singleQuoted) return singleQuoted

  const nameFixed = jsonStr.replace(NAME_QUOTE_RE, '"name":"$1"$2')
  const nameResult = nameFixed === jsonStr ? undefined : attempt(nameFixed)
  if (nameResult) return nameResult

  // A doubled brace-quote before the first argument key -- `"arguments":{"{"command": "ls"}}`
  // instead of `"arguments":{"command": "ls"}`. Observed from a q8 27B on a long context: the
  // call is entirely well-formed apart from those two characters, and without this the whole
  // action is discarded and the raw markup surfaces as the model's answer.
  //
  // A legitimate object keyed on `{` would be `{"{":`, so the lookahead leaves it alone; and
  // as with every repair here, the result is used only if it parses into a named call.
  const braceFixed = jsonStr.replace(BRACE_DUP_RE, '{"')
  const braceResult = braceFixed === jsonStr ? undefined : attempt(braceFixed)
  if (braceResult) return braceResult

  const bareNameFixed = jsonStr.replace(BARE_NAME_RE, '{"name":"$1",')
  return bareNameFixed === jsonStr ? undefined : attempt(bareNameFixed)
}

export function parseJsonToolCalls(content: string): {
  content: string
  toolCalls: Omit<ToolCall, 'id'>[]
} {
  const toolCalls: Omit<ToolCall, 'id'>[] = []
  let cleanContent = content

  for (const { chunk, raw } of toolCallChunks(content)) {
    let matched = false
    // A tool name with an unbalanced quote (`"name": "read_file,`) desynchronizes the
    // string tracking in jsonObjects, so the object is never extracted whole and the
    // per-object repair never gets a chance. Repairing the chunk first and re-extracting
    // is the only order that recovers those. NAME_QUOTE_RE is anchored on the known
    // "name" key and a bare identifier, so it cannot invent a call out of prose.
    let candidates = jsonObjects(chunk)
    if (candidates.length === 0 || !candidates.some((o) => parseCallObject(o))) {
      // A stray brace-quote desynchronizes extraction the same way, so it has to be repaired
      // at this level too -- BRACE_DUP_RE alone inside parseCallObject never gets a chance.
      const repaired = chunk
        .replace(NAME_QUOTE_RE, '"name":"$1"$2')
        .replace(BRACE_DUP_RE, '{"')
        .replace(BARE_NAME_RE, '{"name":"$1",')
      if (repaired !== chunk) candidates = jsonObjects(repaired)
    }
    const chunkCalls: Omit<ToolCall, 'id'>[] = []
    const orphanObjects: Record<string, unknown>[] = []
    for (const objText of candidates) {
      const parsed = parseCallObject(objText)
      if (!parsed) {
        // Not a call — but a model under context pressure sometimes emits the name and the
        // arguments as SEPARATE objects: `{"name":"execute_command"}\n{"command":"ls"}`.
        // Remember plain nameless objects so they can be married to an argless call below;
        // dropping them silently produced empty-args calls with the arguments in plain sight.
        try {
          const o = JSON.parse(objText) as Record<string, unknown>
          if (o && typeof o === 'object' && !Array.isArray(o) && !('name' in o)) {
            orphanObjects.push(o)
          }
        } catch {}
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
      chunkCalls.push({ name, arguments: args })
      matched = true
    }
    // Conservative marry: exactly one argless call and exactly one orphan object in the same
    // chunk. Anything more ambiguous stays as-is rather than guessing pairings.
    if (chunkCalls.length === 1 && orphanObjects.length === 1) {
      const only = chunkCalls[0]
      const orphan = orphanObjects[0]
      if (only && orphan && Object.keys(only.arguments).length === 0) {
        only.arguments = orphan
      }
    }
    toolCalls.push(...chunkCalls)
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

/**
 * Qwen3.5's native call syntax, taken from its chat_template.jinja:
 *   <tool_call>
 *   <function=NAME>
 *   <parameter=KEY>
 *   value
 *   </parameter>
 *   </function>
 *   </tool_call>
 * Distinct from BOTH existing dialects: qwen3 puts JSON inside <tool_call>, laguna uses
 * arg_key/arg_value. Values are newline-delimited and may span lines, so the closing tag —
 * not a line break — terminates them.
 */
function parseFunctionParamToolCalls(content: string): {
  content: string
  toolCalls: Omit<ToolCall, 'id'>[]
} {
  const calls: Omit<ToolCall, 'id'>[] = []
  const boxes = /<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g
  let cleaned = content
  let match: RegExpExecArray | null
  while ((match = boxes.exec(content)) !== null) {
    const inner = match[1]
    if (inner === undefined) continue
    const fn = /<function=([^>\s]+)\s*>([\s\S]*)/.exec(inner.trim())
    const name = fn?.[1]
    if (!fn || name === undefined) continue
    const args: Record<string, unknown> = {}
    const params = /<parameter=([^>\s]+)\s*>\n?([\s\S]*?)\n?<\/parameter>/g
    let p: RegExpExecArray | null
    while ((p = params.exec(fn[2] ?? '')) !== null) {
      const key = p[1]
      if (key !== undefined) args[key] = coerceArgValue(p[2] ?? '')
    }
    calls.push({ name, arguments: args })
    cleaned = cleaned.replace(match[0], '')
  }
  return { content: cleaned.trim(), toolCalls: calls }
}

const QWEN35_INSTRUCTION = `# Tools

You have access to the following functions:

<tools>
{definitions}
</tools>

If you choose to call a function ONLY reply in the following format with NO suffix:

<tool_call>
<function=example_function_name>
<parameter=example_parameter_1>
value_1
</parameter>
</function>
</tool_call>

<IMPORTANT>
Reminder:
- Function calls MUST follow the specified format: an inner <function=...></function> block must be nested within <tool_call></tool_call> XML tags
- Required parameters MUST be specified
- You may provide optional reasoning for your function call in natural language BEFORE the function call, but NOT after
</IMPORTANT>`

/**
 * Qwen3.5-MoE (e.g. via sabrewing's qwen35 engine). The instruction block is the model's own,
 * copied from its chat template — asking in a foreign dialect makes it fall back to the syntax
 * it was trained on, which the other parsers do not recognize.
 */
export const qwen35Dialect: ToolDialect = {
  name: 'qwen35',
  buildToolsSection(tools) {
    if (!tools || tools.length === 0) return ''
    const definitions = tools.map((t) => JSON.stringify(toolSignature(t))).join('\n')
    return `\n\n${QWEN35_INSTRUCTION.replace('{definitions}', definitions)}`
  },
  parseToolCalls(content) {
    const native = parseFunctionParamToolCalls(content)
    if (native.toolCalls.length > 0) return withIds(native)
    // a model told to use one syntax still sometimes reaches for another
    const json = parseJsonToolCalls(content)
    if (json.toolCalls.length > 0) return withIds(json)
    return withIds(parseKeyValueToolCalls(content))
  },
  formatToolResponse(output) {
    return `<tool_response>\n${output}\n</tool_response>`
  },
}

/**
 * DeepSeek v4 ("DSML" — DeepSeek Markup Language) emits its own tool-call opener,
 * `<｜DSML｜tool_call>`, with full-width vertical bars (U+FF5C), instead of the ASCII
 * `<tool_call>` it is ASKED for. On a clean turn it complies with the ASCII form; under load
 * (long context, heavy reasoning) it falls back to this native token, and often DOUBLES the
 * opener — `<｜DSML｜tool_call>\n<｜DSML｜tool_call>\n{json}` — for a single call.
 *
 * So we ask in Qwen3 form (which it understands) and, on the way back, rewrite the native
 * opener to ASCII and collapse a doubled opener before the shared JSON parser runs. That
 * parser already tolerates the flattened args and dropped closer DeepSeek also produces, so
 * no new extraction logic is needed — only token normalization.
 */
const DSML_OPEN_RE = /<｜DSML｜tool_call>/g
// Two (or more) openers separated by nothing but whitespace are the doubled-opener quirk for
// ONE call; real back-to-back calls always have a JSON body (and usually a closer) between
// their openers, so this never merges two genuine calls.
const DOUBLED_OPEN_RE = /(?:<tool_call>\s*){2,}/g

function normalizeDsmlToolCalls(content: string): string {
  return content.replace(DSML_OPEN_RE, '<tool_call>').replace(DOUBLED_OPEN_RE, '<tool_call>')
}

/**
 * DeepSeek v4. Ask in Qwen3 form; on the way back normalize the native DSML opener to ASCII,
 * then run the same fallback chain as `auto` — DeepSeek emits clean `<tool_call>` JSON when it
 * complies, and its native token once normalized is just more of the same.
 */
export const deepseekDialect: ToolDialect = {
  name: 'deepseek',
  buildToolsSection: qwen3Dialect.buildToolsSection,
  parseToolCalls(content) {
    const normalized = normalizeDsmlToolCalls(content)
    const json = parseJsonToolCalls(normalized)
    if (json.toolCalls.length > 0) return withIds(json)
    const kv = parseKeyValueToolCalls(normalized)
    if (kv.toolCalls.length > 0) return withIds(kv)
    return withIds(parseFunctionParamToolCalls(normalized))
  },
  formatToolResponse: qwen3Dialect.formatToolResponse,
}

/** Ask in Qwen3 form (widely understood), accept either on the way back. */
export const autoDialect: ToolDialect = {
  name: 'auto',
  buildToolsSection: qwen3Dialect.buildToolsSection,
  parseToolCalls(content) {
    const json = parseJsonToolCalls(content)
    if (json.toolCalls.length > 0) return withIds(json)
    const kv = parseKeyValueToolCalls(content)
    if (kv.toolCalls.length > 0) return withIds(kv)
    return withIds(parseFunctionParamToolCalls(content))
  },
  formatToolResponse: qwen3Dialect.formatToolResponse,
}

const DIALECTS: Record<string, ToolDialect> = {
  auto: autoDialect,
  qwen3: qwen3Dialect,
  qwen35: qwen35Dialect,
  laguna: lagunaDialect,
  deepseek: deepseekDialect,
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
