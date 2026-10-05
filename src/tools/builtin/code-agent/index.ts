import { homedir } from 'os'
import { resolveImageRefs } from '../../../agent/attachments'
import type { CodeAgentProvider } from '../../../config/schema'
import { log } from '../../../util/logger'
import type { Tool, ToolCallContext, ToolResult } from '../../types'
import { runClaudeCodeAgent } from './claude'
import { runCodexCodeAgent } from './codex'
import { resolveProviderChain, shouldFailover } from './failover'
import { runOpencodeCodeAgent } from './opencode'
import { parseResumeSession } from './timeout-report'
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
        'If it times out, the result is a report of what the agent did and the state of the tree;',
        'read it, then call again with resume_session and a narrower instruction for the next step,',
        'or split the remaining work into smaller tasks. Do not just repeat the same task.',
        'When telling the user about this tool, refer to it as "the code agent", not "code_agent".',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'A clear description of the coding task to perform',
          },
          images: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Images to show the agent: handles of attached images (img1, img2, ...) or image file ' +
              'paths. The agent cannot see your conversation, so pass any screenshot the task ' +
              "depends on. Defaults to the images attached to the user's current message.",
          },
          working_dir: {
            type: 'string',
            description:
              'Absolute path to the repository or directory the task refers to. Set this whenever ' +
              'the task concerns a specific project — without it the agent runs in the persona ' +
              'workspace, where the task usually makes no sense.',
          },
          resume_session: {
            type: 'string',
            description:
              'Continue a previous code agent session instead of starting fresh — use the value ' +
              'given in a timeout report (e.g. "claude:<id>"). The agent keeps its history and ' +
              'gets a fresh timeout; `task` is its next instruction, e.g. "continue: run only the ' +
              'unit tests and report the failures".',
          },
        },
        required: ['task'],
      },
    },

    async execute(
      params: Record<string, unknown>,
      cwd: string,
      ctx?: ToolCallContext,
    ): Promise<ToolResult> {
      const task = params.task as string
      const { paths: images, missing } = Array.isArray(params.images)
        ? resolveImageRefs(params.images as string[], cwd, ctx?.sessionId)
        : { paths: ctx?.images ?? [], missing: [] }
      if (missing.length > 0) {
        return {
          success: false,
          output: `Could not find image(s): ${missing.join(', ')}. Pass handles like img1 or paths to existing image files.`,
        }
      }
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
      const configured = resolveProviderChain(config.providers, config.provider, 'claude')
      // A session belongs to the backend that created it: resume runs that one backend only, and
      // never fails over (another agent cannot continue it).
      const resume =
        typeof params.resume_session === 'string' && params.resume_session.trim()
          ? parseResumeSession(params.resume_session, Object.keys(BACKENDS))
          : undefined
      const chain = resume
        ? [(resume.provider as CodeAgentProvider | undefined) ?? configured[0] ?? 'claude']
        : configured
      if (resume) log.info('code-agent', `Resuming ${chain[0]} session ${resume.id}`)

      log.info(
        'code-agent',
        `Starting ${chain[0]} task: ${task.substring(0, 100)}${task.length > 100 ? '...' : ''}`,
      )
      log.debug('code-agent', `Working dir: ${workingDir}  providers: ${chain.join(' -> ')}`)
      if (images.length > 0) log.info('code-agent', `Attaching ${images.length} image(s)`)

      const attempted: string[] = []
      let last: ToolResult | undefined

      for (const provider of chain) {
        const backend = BACKENDS[provider] ?? runClaudeCodeAgent
        const result = await backend(
          { ...config, provider },
          task,
          workingDir,
          images,
          resume ? { resumeSession: resume.id } : undefined,
        )
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
