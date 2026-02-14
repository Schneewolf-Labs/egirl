import { type Options as ClaudeAgentOptions, query } from '@anthropic-ai/claude-agent-sdk'
import { log } from '../../util/logger'
import type { Tool, ToolResult } from '../types'

/** Default timeout: 5 minutes */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

export interface CodeAgentConfig {
  permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
  model?: string
  workingDir: string
  maxTurns?: number
  timeoutMs?: number
}

/**
 * Create the code_agent tool backed by Claude Code via the agent SDK.
 * The egirl agent can use this tool to delegate complex coding tasks
 * (refactoring, multi-file edits, debugging) to a code-specialized agent.
 */
export function createCodeAgentTool(config: CodeAgentConfig): Tool {
  return {
    definition: {
      name: 'code_agent',
      description: [
        'Delegate a coding task to an autonomous code agent (Claude Code).',
        'Use this for complex tasks that require multi-file edits, refactoring,',
        'debugging, running tests, or any task that benefits from deep codebase',
        'exploration. The agent has full access to the filesystem and can run commands.',
        "Provide a clear, specific task description. Returns the agent's final result.",
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'A clear description of the coding task to perform',
          },
          working_dir: {
            type: 'string',
            description: 'Working directory for the task (defaults to configured workspace)',
          },
        },
        required: ['task'],
      },
    },

    async execute(params: Record<string, unknown>, cwd: string): Promise<ToolResult> {
      const task = params.task as string
      const workingDir = (params.working_dir as string) ?? config.workingDir ?? cwd

      log.info(
        'code-agent',
        `Starting task: ${task.substring(0, 100)}${task.length > 100 ? '...' : ''}`,
      )
      log.debug('code-agent', `Working dir: ${workingDir}`)

      const startTime = Date.now()
      let sessionId = ''
      let sdkTurns: number | undefined
      let manualTurns = 0
      let totalCost = 0
      let finalResult = ''

      const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const abortController = new AbortController()
      const timeoutId = setTimeout(() => abortController.abort(), timeoutMs)

      const isBypass = config.permissionMode === 'bypassPermissions'
      const options: ClaudeAgentOptions = {
        permissionMode: isBypass ? 'bypassPermissions' : 'default',
        ...(isBypass && { allowDangerouslySkipPermissions: true }),
        model: config.model,
        maxTurns: config.maxTurns,
        cwd: workingDir,
        abortController,
      }

      try {
        for await (const message of query({ prompt: task, options })) {
          if (abortController.signal.aborted) break
          if (!('type' in message)) continue

          switch (message.type) {
            case 'system': {
              if ('session_id' in message) {
                sessionId = message.session_id as string
                log.debug('code-agent', `Session: ${sessionId.slice(0, 8)}...`)
              }
              break
            }

            case 'result': {
              const resultMsg = message as {
                result?: string
                num_turns?: number
                total_cost_usd?: number
              }
              finalResult = resultMsg.result ?? ''
              sdkTurns = resultMsg.num_turns
              totalCost = resultMsg.total_cost_usd ?? totalCost
              break
            }
          }

          // Count assistant turns as fallback if SDK doesn't report them
          if ('message' in message && message.message) {
            const msg = message.message as { role?: string }
            if (msg.role === 'assistant') {
              manualTurns++
            }
          }
        }
      } catch (error) {
        clearTimeout(timeoutId)
        const isTimeout = error instanceof DOMException && error.name === 'AbortError'
        const msg = isTimeout
          ? `Code agent timed out after ${(timeoutMs / 1000).toFixed(0)}s`
          : error instanceof Error
            ? error.message
            : String(error)
        log.error('code-agent', `Task failed: ${msg}`)
        return {
          success: false,
          output: `Code agent error: ${msg}`,
        }
      }
      clearTimeout(timeoutId)

      const turns = sdkTurns ?? manualTurns
      const durationMs = Date.now() - startTime
      const durationSec = (durationMs / 1000).toFixed(1)

      log.info(
        'code-agent',
        `Completed in ${durationSec}s | ${turns} turns | $${totalCost.toFixed(4)}`,
      )

      if (!finalResult) {
        return {
          success: false,
          output: `Code agent completed but returned no result (${turns} turns, ${durationSec}s)`,
        }
      }

      const metadata = `[code_agent: ${turns} turns | $${totalCost.toFixed(4)} | ${durationSec}s | session: ${sessionId.slice(0, 8)}]`

      return {
        success: true,
        output: `${finalResult}\n\n${metadata}`,
      }
    },
  }
}
