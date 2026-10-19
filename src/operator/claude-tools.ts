import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { ToolDefinition } from '../providers/types'
import type { ToolResult } from '../tools/types'
import type { ServedTool } from './hosted-types'

/** The Claude SDK names an MCP tool `mcp__<server>__<tool>`; egirl's server is `egirl`. */
export const MCP_SERVER_NAME = 'egirl'
const TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`

/** The tool name as egirl knows it, from the name Claude emits. */
export function stripToolPrefix(name: string): string {
  return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name
}

/**
 * egirl's tools as an in-process MCP server for the Claude Agent SDK.
 *
 * The SDK takes a `McpServer` instance and connects it over an in-memory transport, so Claude
 * calls `read_file`, `execute_command`, `memory_search` and the rest exactly as the local
 * operator does: each call is served by the hosted session, through the one ToolExecutor and
 * its safety checks. The handlers go on the low-level server rather than through
 * `registerTool`, which wants a Zod shape; a ToolDefinition already carries JSON Schema, which
 * is what the wire format is, so passing it through is a rename, not a translation.
 */
export function createEgirlMcpServer(
  tools: ToolDefinition[],
  call: (name: string, args: Record<string, unknown>) => Promise<ServedTool>,
): McpServer {
  const mcp = new McpServer(
    { name: MCP_SERVER_NAME, version: '1' },
    { capabilities: { tools: {} } },
  )

  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((d) => ({
      name: d.name,
      description: d.description,
      inputSchema: d.parameters as { type: 'object'; [key: string]: unknown },
    })),
  }))

  mcp.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>
    const { result, note } = await call(request.params.name, args)
    return toCallToolResult(result, note)
  })

  return mcp
}

/**
 * A tool result in MCP's shape. An image result becomes an image block Claude can look at; a
 * note from the operator rides as a text block after it.
 */
export function toCallToolResult(result: ToolResult, note?: string): CallToolResult {
  const tail = note ? [{ type: 'text' as const, text: note }] : []
  if (result.isImage) {
    const image = parseDataUrl(result.output)
    if (image) {
      return {
        content: [{ type: 'image', data: image.data, mimeType: image.mimeType }, ...tail],
      }
    }
  }
  return {
    content: [{ type: 'text', text: result.output || '(no output)' }, ...tail],
    ...(result.success ? {} : { isError: true }),
  }
}

export function parseDataUrl(url: string): { mimeType: string; data: string } | undefined {
  const m = url.match(/^data:([^;,]+);base64,(.+)$/s)
  if (!m?.[1] || !m[2]) return undefined
  return { mimeType: m[1], data: m[2] }
}
