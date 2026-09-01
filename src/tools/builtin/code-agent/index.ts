import { homedir } from 'os'
import type { CodeAgentProvider } from '../../../config/schema'
import { log } from '../../../util/logger'
import type { DelegationControl, DelegationRegistry } from '../../delegation-registry'
import type { Tool, ToolResult } from '../../types'
import { runClaudeCodeAgent } from './claude'
import { runCodexCodeAgent } from './codex'
import { resolveProviderChain, shouldFailover } from './failover'
import { runOpencodeCodeAgent } from './opencode'
import type { CodeAgentBackend, CodeAgentConfig } from './types'
import { STEERABLE_BACKENDS } from './types'
import { resolveWorkingDir } from './working-dir'

export { createDelegationControlTools } from './control-tools'
export type { CodeAgentConfig, CodeAgentProvider } from './types'

// Dispatch table. A new provider literal in CODE_AGENT_PROVIDERS makes this a
// compile error until its backend is wired in here.
const BACKENDS: Record<CodeAgentProvider, CodeAgentBackend> = {
  claude: runClaudeCodeAgent,
  codex: runCodexCodeAgent,
  opencode: runOpencodeCodeAgent,
}

/**
 * Run the task down the provider chain, failing over while a backend cannot run it at all.
 *
 * `hadProgress` is what stops failover from being destructive in the background: a delegate
 * that has already edited files and then dies is not a candidate for a clean retry on the next
 * provider — that would silently start a second agent over half-finished work under the same
 * delegation id. Failover is for a backend that never got going.
 */
async function runChain(
  config: CodeAgentConfig,
  task: string,
  workingDir: string,
  chain: CodeAgentProvider[],
  control?: DelegationControl,
  onFailover?: (provider: CodeAgentProvider) => void,
  hadProgress?: () => boolean,
): Promise<ToolResult> {
  const attempted: string[] = []
  let last: ToolResult | undefined

  for (const provider of chain) {
    if (attempted.length > 0) onFailover?.(provider)
    const backend = BACKENDS[provider] ?? runClaudeCodeAgent
    const result = await backend({ ...config, provider }, task, workingDir, control)
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
    if (hadProgress?.()) {
      log.warn('code-agent', `${provider} failed after doing work; not failing over`)
      return result
    }

    log.warn('code-agent', `${provider} could not run the task; trying the next provider`)
  }

  return {
    success: false,
    output:
      `All configured code agents failed (${attempted.join(', ')}).\n\n` +
      `Last error:\n${last?.output ?? 'no output'}`,
  }
}

/**
 * Create the code_agent tool backed by a code-specialized agent.
 * The egirl agent can use this tool to delegate complex coding tasks
 * (refactoring, multi-file edits, debugging) to a configured backend.
 *
 * With a delegation registry, the tool also offers `background: true`: the call returns a
 * handle immediately and the run is watched, steered and stopped through the code_agent_*
 * tools instead of blocking the operator for the whole job.
 */
export function createCodeAgentTool(config: CodeAgentConfig, registry?: DelegationRegistry): Tool {
  return {
    definition: {
      name: 'code_agent',
      description: [
        'Delegate a coding task to the code agent.',
        'Use this for complex tasks that require multi-file edits, refactoring,',
        'debugging, running tests, or any task that benefits from deep codebase',
        'exploration. The agent has full access to the filesystem and can run commands.',
        "Provide a clear, specific task description. Returns the agent's final result.",
        ...(registry
          ? [
              'Set background: true for long jobs — the call returns a delegation id straight',
              'away and you keep working; watch it with code_agent_status, correct it with',
              'code_agent_steer, end it with code_agent_stop, and you are told when it finishes.',
            ]
          : []),
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
          ...(registry
            ? {
                background: {
                  type: 'boolean',
                  description:
                    'Run in the background and return a delegation id immediately instead of ' +
                    'waiting for the result (default: false)',
                },
              }
            : {}),
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
      const first = chain[0] ?? 'claude'

      log.info(
        'code-agent',
        `Starting ${first} task: ${task.substring(0, 100)}${task.length > 100 ? '...' : ''}`,
      )
      log.debug('code-agent', `Working dir: ${workingDir}  providers: ${chain.join(' -> ')}`)

      if (params.background === true && registry) {
        const { id, control } = registry.begin({
          task,
          provider: first,
          workingDir,
          steerable: STEERABLE_BACKENDS[first] ?? false,
        })
        // Deliberately not awaited: the point of a background delegation is that the operator's
        // turn ends here. The registry owns the run from now on, including its result.
        void runChain(
          config,
          task,
          workingDir,
          chain,
          control,
          (provider) => registry.setBackend(id, provider, STEERABLE_BACKENDS[provider] ?? false),
          () => (registry.get(id)?.eventCount ?? 0) > 0,
        )
          .then((result) => registry.settle(id, result))
          .catch((error: unknown) => {
            const msg = error instanceof Error ? error.message : String(error)
            registry.settle(id, { success: false, output: `Code agent error: ${msg}` })
          })

        const steerable = STEERABLE_BACKENDS[first] ?? false
        return {
          success: true,
          output: [
            `Started delegation ${id} on ${first} in ${workingDir}.`,
            `Watch it with code_agent_status(id: "${id}")${
              steerable ? `, correct it with code_agent_steer(id: "${id}", message: ...)` : ''
            }, stop it with code_agent_stop(id: "${id}").`,
            'You will be told when it finishes — carry on with something else meanwhile.',
          ].join(' '),
        }
      }

      return runChain(config, task, workingDir, chain)
    },
  }
}
