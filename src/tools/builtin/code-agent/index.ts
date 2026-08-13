import type { CodeAgentProvider } from '../../../config/schema'
import { log } from '../../../util/logger'
import type { Tool, ToolResult } from '../../types'
import { runClaudeCodeAgent } from './claude'
import { runCodexCodeAgent } from './codex'
import { runOpencodeCodeAgent } from './opencode'
import type { CodeAgentBackend, CodeAgentConfig } from './types'

export type { CodeAgentConfig, CodeAgentProvider } from './types'

// Dispatch table. A new provider literal in CODE_AGENT_PROVIDERS makes this a
// compile error until its backend is wired in here.
const BACKENDS: Record<CodeAgentProvider, CodeAgentBackend> = {
  claude: runClaudeCodeAgent,
  codex: runCodexCodeAgent,
  opencode: runOpencodeCodeAgent,
}

/**
 * Create the code_agent tool backed by a code-specialized agent.
 * The egirl agent can use this tool to delegate complex coding tasks
 * (refactoring, multi-file edits, debugging) to a configured backend.
 */
export function createCodeAgentTool(config: CodeAgentConfig): Tool {
  return {
    definition: {
      name: 'code_agent',
      description: [
        'Delegate a coding task to the code agent.',
        'Use this for complex tasks that require multi-file edits, refactoring,',
        'debugging, running tests, or any task that benefits from deep codebase',
        'exploration. The agent has full access to the filesystem and can run commands.',
        "Provide a clear, specific task description. Returns the agent's final result.",
        'When telling the user about this tool, refer to it as "the code agent", not "code_agent".',
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
      const provider = config.provider ?? 'claude'

      log.info(
        'code-agent',
        `Starting ${provider} task: ${task.substring(0, 100)}${task.length > 100 ? '...' : ''}`,
      )
      log.debug('code-agent', `Working dir: ${workingDir}`)

      const backend = BACKENDS[provider] ?? runClaudeCodeAgent
      return backend(config, task, workingDir)
    },
  }
}
