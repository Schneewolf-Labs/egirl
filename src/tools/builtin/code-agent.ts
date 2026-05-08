import { type Options as ClaudeAgentOptions, query } from '@anthropic-ai/claude-agent-sdk'
import { spawn } from 'child_process'
import { join } from 'path'
import type { LLMProvider } from '../../providers/types'
import { sanitizedEnv } from '../../util/env'
import { log } from '../../util/logger'
import type { Tool, ToolResult } from '../types'

/** Default timeout: 5 minutes */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const ESC = String.fromCharCode(27)
const ANSI_OSC_RE = new RegExp(`${ESC}\\][^\\x07]*(?:\\x07|${ESC}\\\\)`, 'g')
const ANSI_CSI_RE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g')
const ANSI_MODE_RE = new RegExp(`${ESC}[>=<][0-?]*`, 'g')
const ANSI_CHARSET_RE = new RegExp(`${ESC}[()#][0-9A-Za-z]`, 'g')
const ANSI_SINGLE_RE = new RegExp(`${ESC}.`, 'g')

export type CodeAgentProvider = 'claude' | 'codex'

export interface CodeAgentConfig {
  provider?: CodeAgentProvider
  permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
  model?: string
  workingDir: string
  maxTurns?: number
  timeoutMs?: number
  localProvider?: LLMProvider
}

/**
 * Create the code_agent tool backed by a code-specialized agent.
 * The egirl agent can use this tool to delegate complex coding tasks
 * (refactoring, multi-file edits, debugging) to Claude Code or Codex.
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

      if (provider === 'codex') {
        return runCodexCodeAgent(config, task, workingDir)
      }

      return runClaudeCodeAgent(config, task, workingDir)
    },
  }
}

async function runClaudeCodeAgent(
  config: CodeAgentConfig,
  task: string,
  workingDir: string,
): Promise<ToolResult> {
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

  log.info('code-agent', `Completed in ${durationSec}s | ${turns} turns | $${totalCost.toFixed(4)}`)

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
}

function codexSandboxFor(permissionMode: CodeAgentConfig['permissionMode']): string {
  if (permissionMode === 'bypassPermissions') return 'danger-full-access'
  return 'workspace-write'
}

function stripAnsi(value: string): string {
  return value
    .replace(ANSI_OSC_RE, '')
    .replace(ANSI_CSI_RE, '')
    .replace(ANSI_MODE_RE, '')
    .replace(ANSI_CHARSET_RE, '')
    .replace(ANSI_SINGLE_RE, '')
}

function codexArgs(config: CodeAgentConfig, task: string, workingDir: string): string[] {
  const args = [
    '--no-alt-screen',
    '--cd',
    workingDir,
    '--ask-for-approval',
    config.permissionMode === 'bypassPermissions' ? 'never' : 'on-request',
    '--sandbox',
    codexSandboxFor(config.permissionMode),
  ]

  if (config.permissionMode === 'bypassPermissions') {
    args.unshift('--dangerously-bypass-approvals-and-sandbox')
  }
  if (config.model) {
    args.push('--model', config.model)
  }
  args.push(task)

  return args
}

function codexChoicePrompt(screen: string): string | undefined {
  const compact = screen.replace(/\s+/g, '').toLowerCase()
  const lower = screen.toLowerCase()

  if (compact.includes('doyoutrustthecontentsofthisdirectory?')) {
    return [
      'Codex asks whether to trust the working directory.',
      '',
      screen.slice(-2000),
      '',
      'Choose one option number.',
    ].join('\n')
  }

  const hasChoices = /(?:^|[\s›])\d+\.\s*\S/.test(screen)
  const asksForInput =
    lower.includes('press enter to continue') || lower.includes('allow') || lower.includes('deny')
  if (hasChoices && asksForInput) {
    return [
      'Codex is asking for a permission or clarification decision.',
      '',
      screen.slice(-2500),
      '',
      'Choose one option number.',
    ].join('\n')
  }

  return undefined
}

function extractChoice(answer: string, fallback: string): string {
  const match = answer.match(/\b\d+\b/)
  return match?.[0] ?? fallback
}

function codexCompletionIndex(screen: string): number {
  return Math.max(
    screen.lastIndexOf('Completed.'),
    screen.lastIndexOf('• Completed'),
    screen.lastIndexOf('• Created'),
    screen.lastIndexOf('• Done'),
    screen.lastIndexOf('• Fixed'),
    screen.lastIndexOf('• Implemented'),
    screen.lastIndexOf('• Updated'),
  )
}

function codexWorkingIndex(screen: string): number {
  return Math.max(
    screen.lastIndexOf('Working('),
    screen.lastIndexOf('Working ('),
    screen.lastIndexOf('Wrk '),
  )
}

function codexTranscriptLooksComplete(screen: string): boolean {
  const workingIndex = codexWorkingIndex(screen)
  return workingIndex >= 0 && codexCompletionIndex(screen) > workingIndex
}

async function chooseCodexOption(
  config: CodeAgentConfig,
  screen: string,
  originalTask: string,
): Promise<string> {
  const prompt = codexChoicePrompt(screen)
  if (!prompt) return '1'

  if (!config.localProvider) {
    return '1'
  }

  try {
    const response = await config.localProvider.chat({
      messages: [
        {
          role: 'system',
          content: [
            'You supervise the Codex interactive CLI for egirl.',
            'Choose the safest practical numbered option for the original coding task.',
            'Allow ordinary reads, writes, edits, and safe commands needed for the task.',
            'Deny destructive actions, secret access, or unrelated network access unless explicitly required.',
            'Respond with only the option number.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [`Original task: ${originalTask}`, '', prompt, '', 'Option number:'].join('\n'),
        },
      ],
      temperature: 0.1,
      max_tokens: 20,
    })

    return extractChoice(response.content, '1')
  } catch (error) {
    log.warn('code-agent', `Local model failed to decide Codex prompt, using option 1: ${error}`)
    return '1'
  }
}

async function runCodexCodeAgent(
  config: CodeAgentConfig,
  task: string,
  workingDir: string,
): Promise<ToolResult> {
  const startTime = Date.now()
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return new Promise((resolvePromise) => {
    let rawOutput = ''
    let jsonBuffer = ''
    let timedOut = false
    let settled = false
    let handlingPrompt = false
    let promptHandledAt = 0
    let lastPromptSignature = ''
    let stopSent = false

    const finish = (result: ToolResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(result)
    }

    const duration = (): string => ((Date.now() - startTime) / 1000).toFixed(1)

    const runnerPath = join(import.meta.dir, 'codex-pty-runner.cjs')
    const encodedArgs = Buffer.from(JSON.stringify(codexArgs(config, task, workingDir))).toString(
      'base64',
    )
    const proc = spawn('node', [runnerPath, workingDir, encodedArgs], {
      cwd: workingDir,
      env: {
        ...sanitizedEnv(),
        TERM: 'xterm-256color',
        NO_COLOR: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const timer = setTimeout(() => {
      timedOut = true
      proc.stdin.write(`${JSON.stringify({ type: 'kill' })}\n`)
      proc.kill('SIGTERM')
      const output = stripAnsi(rawOutput).trim()
      if (codexTranscriptLooksComplete(output)) {
        finish({
          success: true,
          output: `${output}\n\n[code_agent: codex interactive | ${duration()}s]`,
        })
        return
      }
      finish({
        success: false,
        output: `Code agent timed out after ${(timeoutMs / 1000).toFixed(0)}s\n\nPartial output:\n${output}`,
      })
    }, timeoutMs)

    proc.on('error', (error) => {
      finish({
        success: false,
        output: `Code agent error: ${error.message}`,
      })
    })

    proc.stderr.on('data', (data) => {
      rawOutput += data.toString()
    })

    const handleCodexData = (data: string): void => {
      rawOutput += data
      const screen = stripAnsi(rawOutput).slice(-5000)
      const now = Date.now()
      const prompt = codexChoicePrompt(screen)
      const promptSignature = prompt?.slice(-500) ?? ''

      if (
        prompt &&
        promptSignature !== lastPromptSignature &&
        !handlingPrompt &&
        now - promptHandledAt > 1000
      ) {
        handlingPrompt = true
        chooseCodexOption(config, screen, task)
          .then((choice) => {
            promptHandledAt = Date.now()
            lastPromptSignature = promptSignature
            proc.stdin.write(`${JSON.stringify({ type: 'input', data: `${choice}\r` })}\n`)
          })
          .finally(() => {
            handlingPrompt = false
          })
        return
      }

      const taskEchoed = screen.includes(task.slice(0, Math.min(task.length, 80)))
      const statusIndex = screen.lastIndexOf(workingDir)
      const interruptIndex = screen.lastIndexOf('esc to interrupt')
      const workingIndex = codexWorkingIndex(screen)
      const promptIndex = screen.lastIndexOf('›')
      const latestPrompt = statusIndex > Math.max(interruptIndex, workingIndex)
      const completionIndex = codexCompletionIndex(screen)
      const returnedToPrompt =
        latestPrompt &&
        completionIndex > workingIndex &&
        promptIndex >= 0 &&
        promptIndex < statusIndex &&
        statusIndex - promptIndex < 200
      const completedAfterWork = workingIndex >= 0 && completionIndex > workingIndex

      if (
        !stopSent &&
        (taskEchoed || completedAfterWork) &&
        returnedToPrompt &&
        Date.now() - startTime > 3000
      ) {
        stopSent = true
        proc.stdin.write(`${JSON.stringify({ type: 'input', data: '\u0003\u0003' })}\n`)
      } else if (!stopSent && completedAfterWork && Date.now() - startTime > 3000) {
        stopSent = true
        proc.stdin.write(`${JSON.stringify({ type: 'input', data: '\u0003\u0003' })}\n`)
      }
    }

    const handleRunnerLine = (line: string): void => {
      if (!line.trim()) return
      let event: { type?: string; data?: string; exitCode?: number; error?: string }
      try {
        event = JSON.parse(line)
      } catch {
        rawOutput += line
        return
      }

      if (event.type === 'data' && typeof event.data === 'string') {
        handleCodexData(event.data)
      } else if (event.type === 'error' && event.error) {
        rawOutput += `\n${event.error}\n`
      }
    }

    proc.stdout.on('data', (data) => {
      jsonBuffer += data.toString()
      const lines = jsonBuffer.split('\n')
      jsonBuffer = lines.pop() ?? ''
      for (const line of lines) {
        handleRunnerLine(line)
      }
    })

    proc.on('close', (exitCode) => {
      if (timedOut) return

      const output = stripAnsi(rawOutput).trim()
      if (exitCode !== 0) {
        log.error('code-agent', `Codex interactive task failed with exit code ${exitCode}`)
        finish({
          success: false,
          output: `Code agent error: Codex exited with code ${exitCode}\n\n${output}`,
        })
        return
      }

      log.info('code-agent', `Codex completed in ${duration()}s`)
      finish({
        success: true,
        output: `${output}\n\n[code_agent: codex interactive | ${duration()}s]`,
      })
    })
  })
}
