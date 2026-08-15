import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Tool, ToolResult } from '../tools/types'
import { sanitizedEnv } from '../util/env'
import { log } from '../util/logger'

/**
 * Connect to MCP servers and expose their tools as ordinary egirl tools.
 *
 * The point is that nothing downstream knows the difference. An MCP tool arrives at the executor
 * with the same shape as `read_file`, so safety, energy, permissions and the prompt all treat it
 * identically. MCP's `inputSchema` is already JSON Schema, which is what ToolDefinition.parameters
 * holds, so the conversion is a rename rather than a translation.
 *
 * Two rules that matter more than the plumbing:
 *
 * **A dead server must not take the agent with it.** These are other people's processes and
 * network endpoints. Connection is attempted per server, failures are logged and skipped, and one
 * unreachable server costs its own tools and nothing else.
 *
 * **Names are namespaced.** Two servers offering `search` would otherwise silently shadow each
 * other, and the model would call one believing it was the other. `<server>_<tool>` keeps them
 * distinct and keeps the origin visible in transcripts.
 */

export interface McpServerConfig {
  name: string
  /** stdio: the command to spawn. */
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** http: the endpoint to connect to. */
  url?: string
  headers?: Record<string, string>
  timeoutMs?: number
}

export interface McpConnection {
  name: string
  client: Client
  close(): Promise<void>
}

const DEFAULT_TIMEOUT_MS = 30_000

/** Tool names go into the model's prompt; keep them to what a tool name is allowed to look like. */
function toolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/g, '_')
  return `${clean(server)}_${clean(tool)}`
}

/**
 * Flatten an MCP result into the single string egirl tools return.
 *
 * MCP returns an array of typed content blocks. Text is the common case; images are passed through
 * as data URLs because egirl already handles those (see the screenshot tool), and anything else is
 * described rather than dropped, so a model is never told "" when something did come back.
 */
function flattenContent(result: unknown): { text: string; isImage: boolean } {
  const content = (result as { content?: unknown[] })?.content
  if (!Array.isArray(content)) {
    return { text: typeof result === 'string' ? result : JSON.stringify(result), isImage: false }
  }

  const parts: string[] = []
  let isImage = false
  for (const block of content) {
    const b = block as { type?: string; text?: string; data?: string; mimeType?: string }
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text)
    } else if (b.type === 'image' && b.data) {
      isImage = true
      parts.push(`data:${b.mimeType ?? 'image/png'};base64,${b.data}`)
    } else if (b.type === 'resource') {
      const r = (block as { resource?: { text?: string; uri?: string } }).resource
      parts.push(r?.text ?? `[resource: ${r?.uri ?? 'unknown'}]`)
    } else {
      parts.push(`[${b.type ?? 'unknown'} content]`)
    }
  }
  return { text: parts.join('\n'), isImage }
}

async function connectOne(server: McpServerConfig): Promise<McpConnection | undefined> {
  const client = new Client({ name: 'egirl', version: '1.0.0' }, { capabilities: {} })

  try {
    if (server.url) {
      const transport = new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: server.headers ? { headers: server.headers } : undefined,
      })
      await client.connect(transport)
    } else if (server.command) {
      const transport = new StdioClientTransport({
        command: server.command,
        args: server.args ?? [],
        // Secrets are stripped the same way they are for the code agent; a server that needs a
        // token should be given it explicitly via `env`.
        env: { ...(sanitizedEnv() as Record<string, string>), ...(server.env ?? {}) },
      })
      await client.connect(transport)
    } else {
      log.warn('mcp', `Server '${server.name}' has neither url nor command; skipping`)
      return undefined
    }
  } catch (error) {
    log.warn('mcp', `Could not connect to '${server.name}': ${(error as Error).message}`)
    return undefined
  }

  return {
    name: server.name,
    client,
    close: async () => {
      await client.close().catch(() => {})
    },
  }
}

function wrapTool(conn: McpConnection, server: McpServerConfig, mcpTool: unknown): Tool {
  const t = mcpTool as { name: string; description?: string; inputSchema?: Record<string, unknown> }
  const timeout = server.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    definition: {
      name: toolName(server.name, t.name),
      description: t.description ?? `${t.name} (via ${server.name})`,
      // MCP inputSchema is JSON Schema already. An empty object is still valid: some tools take
      // no arguments, and a missing `parameters` would render as a malformed tool definition.
      parameters: t.inputSchema ?? { type: 'object', properties: {} },
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      try {
        const result = await conn.client.callTool({ name: t.name, arguments: params }, undefined, {
          timeout,
        })
        const { text, isImage } = flattenContent(result)
        // MCP reports tool-level failure in-band via isError, which is not an exception.
        const failed = (result as { isError?: boolean })?.isError === true
        return {
          success: !failed,
          output: text || (failed ? 'Tool reported an error with no message.' : '(no output)'),
          ...(isImage ? { isImage: true } : {}),
        }
      } catch (error) {
        return {
          success: false,
          output: `MCP call to ${server.name}.${t.name} failed: ${(error as Error).message}`,
        }
      }
    },
  }
}

/**
 * Connect every configured server and return their tools, plus a closer.
 *
 * Servers are connected concurrently; one that hangs is bounded by its own transport timeout
 * rather than delaying the others.
 */
export async function connectMcpServers(
  servers: McpServerConfig[],
): Promise<{ tools: Tool[]; connections: McpConnection[] }> {
  const results = await Promise.all(
    servers.map(async (server) => {
      const conn = await connectOne(server)
      if (!conn) return { tools: [] as Tool[], connections: [] as McpConnection[] }

      try {
        const listed = await conn.client.listTools()
        const tools = (listed.tools ?? []).map((t) => wrapTool(conn, server, t))
        log.info(
          'mcp',
          `Connected to '${server.name}': ${tools.length} tool(s) — ${tools
            .map((x) => x.definition.name)
            .join(', ')}`,
        )
        return { tools, connections: [conn] }
      } catch (error) {
        log.warn(
          'mcp',
          `Connected to '${server.name}' but listing tools failed: ${(error as Error).message}`,
        )
        await conn.close()
        return { tools: [] as Tool[], connections: [] as McpConnection[] }
      }
    }),
  )

  return {
    tools: results.flatMap((r) => r.tools),
    connections: results.flatMap((r) => r.connections),
  }
}
