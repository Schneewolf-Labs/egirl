import { homedir } from 'os'
import type { CodeAgentProvider } from '../../../config/schema'
import { log } from '../../../util/logger'
import type { Tool, ToolResult } from '../../types'
import { runClaudeCodeAgent } from './claude'
import { runCodexCodeAgent } from './codex'
import { resolveProviderChain, shouldFailover } from './failover'
import { runOpencodeCodeAgent } from './opencode'
import type { CodeAgentBackend, CodeAgentConfig } from './types'
import { resolveWorkingDir } from './working-dir'

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
            description:
              'Absolute path to the repository or directory the task refers to. Set this whenever ' +
              'the task concerns a specific project — without it the agent runs in the persona ' +
              'workspace, where the task usually makes no sense.',
          },
        },
        required: ['task'],
      },
    },

    async execute(params: Record<string, unknown>, cwd: string): Promise<ToolResult> {
      const task = params.task as string
      const { dir: workingDir, inferred } = resolveWorkingDir({
        explicit: params.working_dir as string | undefined,
        task,
        configured: config.workingDir,
        cwd,
        home: homedir(),
      })
      if (inferred) {
        log.info('code-agent', `Inferred working_dir from the task text: ${workingDir}`)
      }
      const chain = resolveProviderChain(config.providers, config.provider, 'claude')

      log.info(
        'code-agent',
        `Starting ${chain[0]} task: ${task.substring(0, 100)}${task.length > 100 ? '...' : ''}`,
      )
      log.debug('code-agent', `Working dir: ${workingDir}  providers: ${chain.join(' -> ')}`)

      const attempted: string[] = []
      let last: ToolResult | undefined

      for (const provider of chain) {
        const backend = BACKENDS[provider] ?? runClaudeCodeAgent
        const result = await backend({ ...config, provider }, task, workingDir)
        attempted.push(provider)
        last = result

        if (result.success) {
          // Say which provider answered when it was not the first choice, so a silent
          // degradation to a cheaper or weaker agent is visible in the transcript.
          return attempted.length > 1
            ? { ...result, output: `${result.output}\n\n[failed over: ${attempted.join(' -> ')}]` }
            : result
        }

        if (!shouldFailover(result)) return result

        log.warn('code-agent', `${provider} could not run the task; trying the next provider`)
      }

      return {
        success: false,
        output:
          `All configured code agents failed (${attempted.join(', ')}).\n\n` +
          `Last error:\n${last?.output ?? 'no output'}`,
      }
    },
  }
}
