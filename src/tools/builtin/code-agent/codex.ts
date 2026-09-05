import { spawn } from 'child_process'
import { join } from 'path'
import { sanitizedEnv } from '../../../util/env'
import { log } from '../../../util/logger'
import type { ToolResult } from '../../types'
import { NODE_BINARY_MISSING, nodeBinary } from './node-binary'
import { DEFAULT_TIMEOUT_MS, stripAnsi } from './shared'
import type { CodeAgentBackend, CodeAgentConfig } from './types'

function codexSandboxFor(permissionMode: CodeAgentConfig['permissionMode']): string {
  if (permissionMode === 'bypassPermissions') return 'danger-full-access'
  return 'workspace-write'
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

export function codexChoicePrompt(screen: string): string | undefined {
  const latestPrompt = screen.lastIndexOf('›')
  if (latestPrompt >= 0 && !/^›\s*\d+\./.test(screen.slice(latestPrompt))) return undefined
  const compact = screen.replace(/\s+/g, '').toLowerCase()
  const lower = screen.toLowerCase()

  if (compact.includes('doyoutrustthecontentsofthisdirectory?')) {
    if (!lower.includes('press enter to continue')) return undefined
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

function codexOptions(screen: string): { id: string; label: string }[] {
  const options: { id: string; label: string }[] = []
  const optionRe = /(?:^|\n|\s)(\d+)\.\s*([^\n\r]+)/g
  for (const match of screen.matchAll(optionRe)) {
    const id = match[1]
    const label = match[2]?.trim()
    if (id && label && !options.some((option) => option.id === id)) {
      options.push({ id, label })
    }
  }
  return options
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

/**
 * A clean exit with nothing on the screen is not success.
 *
 * Codex can exit 0 in a tenth of a second having done nothing — most often because it was pointed
 * at a directory where the task makes no sense. Reporting that as success is worse than reporting
 * an error: the operator model reads "completed", tells the user the work is underway, and the
 * absence of any change is never surfaced. Observed live: a task to fix a failing suite ran in the
 * persona workspace instead of the target repo, returned `success: true` with an empty transcript
 * in 0.1s, and the agent replied "the code agent is working on it".
 *
 * Exported for testing — the spawn path cannot be exercised without a real codex binary.
 */
export function interpretCodexExit(
  exitCode: number | null,
  output: string,
  workingDir: string,
  seconds: string,
): { success: boolean; output: string } | undefined {
  if (output.trim().length > 0) return undefined
  return {
    success: false,
    output:
      `Code agent produced no output (exit ${exitCode ?? 'null'}, ${seconds}s) in ${workingDir}. ` +
      'Nothing was done. The usual cause is a working directory where the task does not apply — ' +
      'check that working_dir points at the repository the task refers to.',
  }
}

function codexTranscriptLooksComplete(screen: string): boolean {
  const workingIndex = codexWorkingIndex(screen)
  const completionIndex = codexCompletionIndex(screen)
  if (completionIndex < 0) return false
  if (screen.includes('• Completed') || screen.includes('• Created')) return true
  return workingIndex >= 0 && completionIndex > workingIndex
}

async function chooseCodexOption(
  config: CodeAgentConfig,
  screen: string,
  originalTask: string,
  workingDir: string,
): Promise<{ choice?: string; needsUser?: string }> {
  const prompt = codexChoicePrompt(screen)
  if (!prompt) return { choice: '1' }

  if (!config.permissionSupervisor) {
    return { choice: '1' }
  }

  const decision = await config.permissionSupervisor.decide({
    backend: 'codex',
    kind: prompt.includes('trust the working directory') ? 'trust' : 'permission',
    originalTask,
    workingDir,
    promptText: prompt,
    options: codexOptions(screen),
    recentContext: screen.slice(-3000),
  })

  if (decision.action === 'ask_user') {
    return { needsUser: decision.reason }
  }

  if (decision.action === 'deny') {
    const denyOption = codexOptions(screen).find((option) =>
      /deny|no|cancel|reject/i.test(option.label),
    )
    return { choice: denyOption?.id ?? decision.optionId ?? '1' }
  }

  return { choice: decision.optionId ?? '1' }
}

export const runCodexCodeAgent: CodeAgentBackend = (config, task, workingDir) => {
  const startTime = Date.now()
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS

  // `node` by name resolves to bun under this project's bunfig -- see node-binary.ts. Checked
  // before the promise body, which cannot settle until its timer exists.
  const nodeBin = nodeBinary()
  if (!nodeBin) {
    log.error('code-agent', NODE_BINARY_MISSING)
    return Promise.resolve({ success: false, output: NODE_BINARY_MISSING })
  }

  return new Promise<ToolResult>((resolvePromise) => {
    let rawOutput = ''
    let jsonBuffer = ''
    let timedOut = false
    let settled = false
    let handlingPrompt = false
    let promptHandledAt = 0
    let lastPromptSignature = ''
    let stopSent = false
    let completionTimer: ReturnType<typeof setTimeout> | undefined

    const finish = (result: ToolResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(completionTimer)
      resolvePromise(result)
    }

    const duration = (): string => ((Date.now() - startTime) / 1000).toFixed(1)

    const runnerPath = join(import.meta.dir, 'codex-pty-runner.cjs')
    const encodedArgs = Buffer.from(JSON.stringify(codexArgs(config, task, workingDir))).toString(
      'base64',
    )
    const proc = spawn(nodeBin, [runnerPath, workingDir, encodedArgs], {
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
      clearTimeout(completionTimer)
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
        chooseCodexOption(config, screen, task, workingDir)
          .then(async (decision) => {
            promptHandledAt = Date.now()
            lastPromptSignature = promptSignature
            if (decision.needsUser) {
              proc.stdin.write(`${JSON.stringify({ type: 'kill' })}\n`)
              proc.kill('SIGTERM')
              finish({
                success: false,
                output: [
                  'Code agent needs user approval before continuing.',
                  '',
                  decision.needsUser,
                  '',
                  stripAnsi(rawOutput).trim(),
                ].join('\n'),
              })
              return
            }
            // ConPTY may deliver the prompt before its input handler is ready.
            if (process.platform === 'win32') await new Promise((r) => setTimeout(r, 250))
            if (settled) return
            proc.stdin.write(`${JSON.stringify({ type: 'input', data: decision.choice })}\n`)
            if (process.platform === 'win32') await new Promise((r) => setTimeout(r, 50))
            if (!settled) proc.stdin.write(`${JSON.stringify({ type: 'input', data: '\r' })}\n`)
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

      if (process.platform === 'win32') {
        if (!stopSent && codexTranscriptLooksComplete(screen) && promptIndex > completionIndex) {
          completionTimer = setTimeout(() => {
            if (settled) return
            stopSent = true
            proc.stdin.write(`${JSON.stringify({ type: 'kill' })}\n`)
          }, 500)
        }
        return
      }

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
        if (codexTranscriptLooksComplete(output)) {
          log.info('code-agent', `Codex completed in ${duration()}s`)
          finish({
            success: true,
            output: `${output}\n\n[code_agent: codex interactive | ${duration()}s]`,
          })
          return
        }

        log.error('code-agent', `Codex interactive task failed with exit code ${exitCode}`)
        finish({
          success: false,
          output: `Code agent error: Codex exited with code ${exitCode}\n\n${output}`,
        })
        return
      }

      const empty = interpretCodexExit(exitCode, output, workingDir, duration())
      if (empty) {
        log.error('code-agent', `Codex exited ${exitCode} with no output after ${duration()}s`)
        finish(empty)
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
