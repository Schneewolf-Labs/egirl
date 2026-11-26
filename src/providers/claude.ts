/**
 * Side work on Claude, for an instance that is a Claude instance through and through.
 *
 * A Claude operator (`[operator] provider = "claude"`) runs every turn on Claude, but the side
 * work -- memory extraction, the permission supervisor's calls, a task's self-review, summaries --
 * goes through the `[local]` provider, which until now had to be a llama-server. With
 * `[local] provider = "claude"` that provider is this: each `chat()` is one Claude Code query
 * through the Agent SDK on the machine's `claude login`, the same subscription auth the operator
 * uses, with a small model (`model = "haiku"`) since none of this needs the operator's.
 *
 * Chosen once per instance in config, like the operator itself; nothing picks between this and
 * a local model per call. One query is one model turn with no tools: the SDK's built-ins are
 * off, and a caller that offers tools gets text back, which every side-work caller handles.
 */

import { tmpdir } from 'node:os'
import { type Options as ClaudeAgentOptions, query } from '@anthropic-ai/claude-agent-sdk'
import { log } from '../util/logger'
import {
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  getTextContent,
  type LLMProvider,
} from './types'

export type ClaudeQueryFn = typeof query

export function createClaudeProvider(model: string, queryFn: ClaudeQueryFn = query): LLMProvider {
  return {
    name: `claude:${model}`,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const { system, prompt } = toPrompt(req.messages)
      const controller = new AbortController()
      const abort = (): void => controller.abort()
      req.signal?.addEventListener('abort', abort, { once: true })
      const options: ClaudeAgentOptions = {
        ...(system && { systemPrompt: system }),
        model,
        // Nothing but the model: no built-in tools, no machine settings, CLAUDE.md or MCP servers.
        tools: [],
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: {},
        maxTurns: 1,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        // No session to come back to, and no workspace to read: a scratch directory.
        cwd: tmpdir(),
        persistSession: false,
        abortController: controller,
      }
      try {
        let content = ''
        let usage = { input_tokens: 0, output_tokens: 0 }
        for await (const message of queryFn({ prompt, options })) {
          if (message.type !== 'result') continue
          usage = {
            input_tokens: message.usage.input_tokens ?? 0,
            output_tokens: message.usage.output_tokens ?? 0,
          }
          if (message.subtype !== 'success') {
            throw new Error(`Claude side-work query failed: ${message.subtype}`)
          }
          content = message.result
        }
        req.onToken?.(content)
        return { content, usage, model }
      } finally {
        req.signal?.removeEventListener('abort', abort)
      }
    },
  }
}

/**
 * The messages as one prompt. Side work is almost always a system prompt and one user message;
 * anything longer (a transcript to summarize) is written out turn by turn, tool results too.
 */
export function toPrompt(messages: ChatMessage[]): { system: string; prompt: string } {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => getTextContent(m.content))
    .join('\n\n')
  const rest = messages.filter((m) => m.role !== 'system')
  if (rest.length === 1 && rest[0]?.role === 'user') {
    return { system, prompt: getTextContent(rest[0].content) }
  }
  if (rest.some((m) => typeof m.content !== 'string' && m.content.some((p) => p.type !== 'text'))) {
    log.debug('claude-side', 'images in a side-work request are sent as text placeholders')
  }
  const prompt = rest
    .map((m) => {
      const text = getTextContent(m.content)
      if (m.role === 'tool') return `[tool result]\n${text}`
      const calls = m.tool_calls?.map((c) => `[called ${c.name}(${JSON.stringify(c.arguments)})]`)
      return `${m.role === 'user' ? 'User' : 'Assistant'}: ${[text, ...(calls ?? [])].filter(Boolean).join('\n')}`
    })
    .join('\n\n')
  return { system, prompt }
}
