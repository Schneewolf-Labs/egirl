import { spawn, type ChildProcess } from 'child_process'
import * as readline from 'readline'
import type { LLMProvider } from '../providers/types'
import { log } from '../util/logger'

// -- Stream-JSON protocol types --

interface ContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
}

interface ClaudeEvent {
  type: string
  subtype?: string
  session_id?: string
  model?: string
  message?: {
    role: string
    content: string | ContentBlock[]
  }
  result?: string
  duration_ms?: number
  total_cost_usd?: number
  num_turns?: number
  permission_denials?: string[]
  tool_use_result?: {
    stdout?: string
    stderr?: string
    interrupted?: boolean
  }
}

// -- Public types --

export interface ClaudeCodeConfig {
  permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
  claudeModel?: string
  workingDir: string
  maxTurns?: number
}

export interface TaskResult {
  result: string
  sessionId: string
  turns: number
  costUsd: number
  durationMs: number
}

// -- Channel --

export class ClaudeCodeChannel {
  private proc: ChildProcess | null = null
  private localProvider: LLMProvider
  private config: ClaudeCodeConfig
  private sessionId: string | null = null
  private conversationLog: string[] = []
  private emit: (line: string) => void

  constructor(
    localProvider: LLMProvider,
    config: ClaudeCodeConfig,
    emit?: (line: string) => void
  ) {
    this.localProvider = localProvider
    this.config = config
    this.emit = emit ?? ((line) => console.log(line))
  }

  async runTask(prompt: string): Promise<TaskResult> {
    this.conversationLog = [`Task: ${prompt}`]
    this.spawnProcess()
    this.sendMessage(prompt)
    return this.processEvents(prompt)
  }

  async resumeSession(sessionId: string, prompt: string): Promise<TaskResult> {
    this.conversationLog = [`Resumed session ${sessionId}`, `Follow-up: ${prompt}`]
    this.spawnProcess(['--resume', sessionId])
    this.sendMessage(prompt)
    return this.processEvents(prompt)
  }

  async startInteractive(): Promise<void> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    console.log('\negirl Claude Code bridge')
    console.log('Type a task for Claude Code. Local model answers its questions.')
    console.log('Type "exit" to quit.\n')

    const prompt = (): void => {
      rl.question('task> ', async (input) => {
        const trimmed = input.trim()

        if (trimmed === 'exit' || trimmed === 'quit') {
          this.stop()
          rl.close()
          return
        }

        if (!trimmed) {
          prompt()
          return
        }

        try {
          const result = await this.runTask(trimmed)
          console.log(`\n--- Result ---`)
          console.log(result.result)
          console.log(`[${result.turns} turns | $${result.costUsd.toFixed(4)} | ${(result.durationMs / 1000).toFixed(1)}s]\n`)
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          console.error(`\nError: ${msg}\n`)
        }

        prompt()
      })
    }

    prompt()
  }

  stop(): void {
    this.cleanup()
  }

  getSessionId(): string | null {
    return this.sessionId
  }

  // -- Internal --

  private spawnProcess(extraArgs: string[] = []): void {
    const args = [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', this.config.permissionMode,
      ...extraArgs,
    ]

    if (this.config.claudeModel) {
      args.push('--model', this.config.claudeModel)
    }

    if (this.config.maxTurns) {
      args.push('--max-turns', String(this.config.maxTurns))
    }

    this.emit(`[cc] Spawning claude ${args.join(' ')}`)
    log.info('claude-code', `Working dir: ${this.config.workingDir}`)

    this.proc = spawn('claude', args, {
      cwd: this.config.workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim()
      if (text) log.debug('claude-code', `stderr: ${text}`)
    })
  }

  private async processEvents(originalTask: string): Promise<TaskResult> {
    if (!this.proc?.stdout) {
      throw new Error('No stdout from claude process')
    }

    const rl = readline.createInterface({ input: this.proc.stdout })
    let pendingQuestion: string | null = null

    try {
      for await (const line of rl) {
        let event: ClaudeEvent
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }

        log.debug('claude-code', `Event: ${event.type}${event.subtype ? `.${event.subtype}` : ''}`)

        switch (event.type) {
          case 'system':
            this.handleSystemEvent(event)
            break

          case 'assistant':
            pendingQuestion = this.handleAssistantEvent(event)
            break

          case 'user':
            this.handleToolResultEvent(event)
            break

          case 'result': {
            if (pendingQuestion) {
              const answer = await this.answerWithLocalModel(originalTask, pendingQuestion)
              this.emit(`[local] ${answer}`)
              this.conversationLog.push(`Local model answered: ${answer}`)
              this.sendMessage(answer)
              pendingQuestion = null
            } else {
              rl.close()
              this.cleanup()
              return {
                result: event.result ?? '',
                sessionId: event.session_id ?? this.sessionId ?? '',
                turns: event.num_turns ?? 0,
                costUsd: event.total_cost_usd ?? 0,
                durationMs: event.duration_ms ?? 0,
              }
            }
            break
          }
        }
      }
    } catch (error) {
      rl.close()
      this.cleanup()
      throw error
    }

    rl.close()
    this.cleanup()
    throw new Error('Claude Code process ended without a result event')
  }

  private handleSystemEvent(event: ClaudeEvent): void {
    if (event.subtype === 'init') {
      this.sessionId = event.session_id ?? null
      this.emit(`[cc] Session ${this.sessionId?.slice(0, 8)}... | Model: ${event.model}`)
    }
  }

  /**
   * Parse assistant event for text output and question detection.
   * Returns the question text if Claude Code is asking one, null otherwise.
   */
  private handleAssistantEvent(event: ClaudeEvent): string | null {
    const content = event.message?.content
    if (!content) return null

    if (typeof content === 'string') {
      if (content.trim()) this.emit(`[cc] ${content}`)
      return null
    }

    let question: string | null = null

    for (const block of content) {
      if (block.type === 'text' && block.text) {
        this.emit(`[cc] ${block.text}`)
        this.conversationLog.push(`Claude: ${block.text}`)
      } else if (block.type === 'tool_use') {
        if (this.isQuestionTool(block.name)) {
          question = this.extractQuestion(block.input)
          this.emit(`[cc:question] ${question}`)
        } else {
          this.logToolUse(block)
        }
      }
    }

    return question
  }

  private handleToolResultEvent(event: ClaudeEvent): void {
    const result = event.tool_use_result
    if (!result) return

    if (result.stdout) {
      const out = result.stdout.length > 300
        ? result.stdout.slice(0, 300) + '...'
        : result.stdout
      log.debug('claude-code', `Tool stdout: ${out}`)
    }

    if (result.stderr) {
      log.debug('claude-code', `Tool stderr: ${result.stderr.slice(0, 200)}`)
    }
  }

  private isQuestionTool(name?: string): boolean {
    if (!name) return false
    return /ask|question|user.?input|prompt/i.test(name)
  }

  private extractQuestion(input?: Record<string, unknown>): string {
    if (!input) return '(no question text)'
    return (input.question as string)
      ?? (input.text as string)
      ?? (input.message as string)
      ?? (input.content as string)
      ?? JSON.stringify(input)
  }

  private logToolUse(block: ContentBlock): void {
    const name = block.name ?? 'unknown'
    const input = block.input ?? {}

    switch (name) {
      case 'Bash':
        this.emit(`[cc:bash] ${input.command ?? ''}`)
        this.conversationLog.push(`Bash: ${input.command}`)
        break
      case 'Read':
        this.emit(`[cc:read] ${input.file_path ?? ''}`)
        break
      case 'Edit':
        this.emit(`[cc:edit] ${input.file_path ?? ''}`)
        this.conversationLog.push(`Edit: ${input.file_path}`)
        break
      case 'Write':
        this.emit(`[cc:write] ${input.file_path ?? ''}`)
        this.conversationLog.push(`Write: ${input.file_path}`)
        break
      case 'Glob':
        this.emit(`[cc:glob] ${input.pattern ?? ''}`)
        break
      case 'Grep':
        this.emit(`[cc:grep] ${input.pattern ?? ''}`)
        break
      case 'Task':
        this.emit(`[cc:task] ${input.description ?? ''}`)
        break
      default:
        this.emit(`[cc:${name.toLowerCase()}] ${JSON.stringify(input).slice(0, 100)}`)
        break
    }
  }

  private async answerWithLocalModel(
    originalTask: string,
    question: string
  ): Promise<string> {
    const recentContext = this.conversationLog.slice(-15).join('\n')

    const systemPrompt = [
      'You are supervising Claude Code as it works on a task.',
      'It has asked a question and needs your decision.',
      '',
      'Rules:',
      '- Be direct and concise (1-2 sentences max)',
      '- If asked for permission, grant it unless it seems destructive',
      '- If asked to choose an approach, pick the most practical one',
      '- If asked for clarification, answer based on the original task',
      '- Never ask questions back — always give a definitive answer',
      '- If given numbered options, respond with just the number',
    ].join('\n')

    const userPrompt = [
      `Original task: ${originalTask}`,
      '',
      'Recent activity:',
      recentContext,
      '',
      `Claude Code is asking: ${question}`,
      '',
      'Your answer:',
    ].join('\n')

    try {
      const response = await this.localProvider.chat({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 256,
      })

      return response.content.trim() || 'Yes, proceed.'
    } catch (error) {
      log.warn('claude-code', `Local model failed to answer, using fallback: ${error}`)
      return 'Yes, proceed.'
    }
  }

  private sendMessage(content: string): void {
    if (!this.proc?.stdin?.writable) {
      log.error('claude-code', 'Cannot send message: stdin not writable')
      return
    }

    const msg = JSON.stringify({
      type: 'user',
      message: { role: 'user', content },
    })

    this.proc.stdin.write(msg + '\n', 'utf-8')
    log.debug('claude-code', `Sent message: ${content.slice(0, 100)}`)
  }

  private cleanup(): void {
    if (this.proc) {
      try { this.proc.stdin?.end() } catch { /* ignore */ }
      try { this.proc.kill() } catch { /* ignore */ }
      this.proc = null
    }
  }
}

export function createClaudeCodeChannel(
  localProvider: LLMProvider,
  config: ClaudeCodeConfig,
  emit?: (line: string) => void
): ClaudeCodeChannel {
  return new ClaudeCodeChannel(localProvider, config, emit)
}
