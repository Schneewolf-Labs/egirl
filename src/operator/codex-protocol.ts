import type { ThinkingConfig, ToolDefinition } from '../providers/types'
import type { RpcObject } from '../tools/builtin/code-agent/codex-rpc'
import type { ToolResult } from '../tools/types'

/**
 * What goes over the wire to `codex app-server` when Codex is the operator, in egirl's terms.
 * Field names follow the app-server v2 protocol (checked against codex 0.163's generated
 * schema): egirl's tools are Codex "dynamic tools", called back over the same JSON-RPC pipe as
 * `item/tool/call` requests, so no MCP server is involved.
 */

/** Initialize: dynamic tools and thread environments are experimental API fields. */
export const CODEX_CAPABILITIES: RpcObject = { experimentalApi: true, requestAttestation: false }

/**
 * Codex's own tools, off. The shell is the one that matters: with it gone, and no environment
 * on the turn, Codex has no hands but egirl's. The rest are agent behaviors egirl owns itself or
 * that would bypass it: spawning sub-agents, its goal tracker, asking the user directly (egirl
 * asks through `report`), and hosted web search (egirl has its own, and narrates it). Checked
 * against codex 0.163 by reading the tools it advertises to the model.
 */
export const CODEX_TOOL_SWITCHES: RpcObject = {
  'features.shell_tool': false,
  'features.multi_agent': false,
  'features.goals': false,
  'tools.experimental_request_user_input.enabled': false,
  web_search: 'disabled',
}

/**
 * Settings shared by thread/start and thread/resume. Base instructions replace Codex's own
 * prompt with the workspace's, as a custom system prompt does for Claude, and are resent on
 * every resume so a changed SOUL.md applies to a continuing conversation. Codex's own tools are
 * switched off and the sandbox is read-only with no approvals, so the only way to act is
 * egirl's tools, through egirl's executor and its safety layer.
 */
export function codexThreadSettings(opts: {
  cwd: string
  instructions: string
  model?: string
}): RpcObject {
  return {
    cwd: opts.cwd,
    baseInstructions: opts.instructions,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    config: CODEX_TOOL_SWITCHES,
    ...(opts.model && { model: opts.model }),
  }
}

/** egirl's tool definitions as Codex dynamic tool specs. Fixed for the life of the thread. */
export function codexDynamicTools(tools: ToolDefinition[]): RpcObject[] {
  return tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    inputSchema: t.parameters,
  }))
}

/**
 * The user turn: text, then attached images as the files egirl saved them to. An empty
 * environment list keeps the turn away from Codex's own shell and file tools.
 */
export function codexTurnParams(opts: {
  threadId: string
  text: string
  imagePaths?: string[]
  thinking: ThinkingConfig['level']
}): RpcObject {
  const effort = codexEffort(opts.thinking)
  return {
    threadId: opts.threadId,
    input: [
      { type: 'text', text: opts.text, text_elements: [] },
      ...(opts.imagePaths ?? []).map((path) => ({ type: 'localImage', path })),
    ],
    environments: [],
    ...(effort && { effort }),
  }
}

/**
 * egirl's thinking level as a Codex reasoning effort. Codex models always reason, and which
 * efforts below `low` a model accepts varies, so `off` sends nothing and leaves the model's
 * default in place.
 */
export function codexEffort(level: ThinkingConfig['level']): string | undefined {
  return level === 'off' ? undefined : level
}

/** A tool result as Codex takes it back; an image becomes an inline image, a note rides after. */
export function codexToolResponse(result: ToolResult, note?: string): RpcObject {
  const body =
    result.isImage && result.output.startsWith('data:')
      ? { type: 'inputImage', imageUrl: result.output }
      : { type: 'inputText', text: result.output || '(no output)' }
  return {
    contentItems: [body, ...(note ? [{ type: 'inputText', text: note }] : [])],
    success: result.success,
  }
}

/** What app-server answers when asked to resume a thread it has no rollout for. */
export function isStaleThread(message: string): boolean {
  return message.includes('no rollout found for thread id') || message.includes('thread not found')
}
