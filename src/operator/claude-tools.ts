import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { ToolExecutor } from '../tools'
import type { ToolCallContext, ToolResult } from '../tools/types'

/** The Claude SDK names an MCP tool `mcp__<server>__<tool>`; egirl's server is `egirl`. */
export const MCP_SERVER_NAME = 'egirl'
const TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`

/** The tool name as egirl knows it, from the name Claude emits. */
export function stripToolPrefix(name: string): string {
  return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name
}

export interface EgirlMcpServerArgs {
  executor: ToolExecutor
  cwd: string
  ctx: ToolCallContext
  /** Runs a tool call under the shared-state lock (SessionMutex), or inline without one. */
  exclusive: <T>(fn: () => Promise<T>) => Promise<T>
  /** A tool finished; what the harness does not tell us because the call ran on our side. */
  onResult?: (name: string, args: Record<string, unknown>, result: ToolResult) => void
}

/**
 * egirl's tool registry as an in-process MCP server for the Claude Agent SDK.
 *
 * The SDK takes a `McpServer` instance and connects it over an in-memory transport, so Claude
 * calls `read_file`, `execute_command`, `memory_search` and the rest exactly as the local
 * operator does: through the one ToolExecutor, with its safety checks, fuzzy name matching and
 * parameter remapping. The handlers go on the low-level server rather than through
 * `registerTool`, which wants a Zod shape; a ToolDefinition already carries JSON Schema, which
 * is what the wire format is, so passing it through is a rename, not a translation.
 */
export function createEgirlMcpServer(args: EgirlMcpServerArgs): McpServer {
  const { executor, cwd, ctx, exclusive, onResult } = args
  const mcp = new McpServer(
    { name: MCP_SERVER_NAME, version: '1' },
    { capabilities: { tools: {} } },
  )
  let next = 0

  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: executor.getDefinitions().map((d) => ({
      name: d.name,
      description: d.description,
      inputSchema: d.parameters as { type: 'object'; [key: string]: unknown },
    })),
  }))

  mcp.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name
    const callArgs = (request.params.arguments ?? {}) as Record<string, unknown>
    const result = await exclusive(() =>
      executor.execute({ id: `call_${next++}`, name, arguments: callArgs }, cwd, ctx),
    )
    onResult?.(name, callArgs, result)
    return toCallToolResult(result)
  })

  return mcp
}

/** A tool result in MCP's shape. An image result becomes an image block Claude can look at. */
export function toCallToolResult(result: ToolResult): CallToolResult {
  if (result.isImage) {
    const image = parseDataUrl(result.output)
    if (image) {
      return { content: [{ type: 'image', data: image.data, mimeType: image.mimeType }] }
    }
  }
  return {
    content: [{ type: 'text', text: result.output || '(no output)' }],
    ...(result.success ? {} : { isError: true }),
  }
}

export function parseDataUrl(url: string): { mimeType: string; data: string } | undefined {
  const m = url.match(/^data:([^;,]+);base64,(.+)$/s)
  if (!m?.[1] || !m[2]) return undefined
  return { mimeType: m[1], data: m[2] }
}
