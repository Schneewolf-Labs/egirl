import { query, type ClaudeAgentOptions } from '@anthropic-ai/claude-agent-sdk'
import * as readline from 'readline'
import type { LLMProvider } from '../providers/types'
import { log } from '../util/logger'

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
  private localProvider: LLMProvider
  private config: ClaudeCodeConfig
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
    return this.executeQuery(prompt)
  }

  async resumeSession(sessionId: string, prompt: string): Promise<TaskResult> {
    this.conversationLog = [`Resumed session ${sessionId}`, `Follow-up: ${prompt}`]
    return this.executeQuery(prompt, sessionId)
  }

  async startInteractive(): Promise<void> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    console.log('\negirl Claude Code bridge')
    console.log('Type a task for Claude Code. Local model handles permissions & questions.')
    console.log('Type "exit" to quit.\n')

    const promptUser = (): void => {
      rl.question('task> ', async (input) => {
        const trimmed = input.trim()

        if (trimmed === 'exit' || trimmed === 'quit') {
          rl.close()
          return
        }

        if (!trimmed) {
          promptUser()
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

        promptUser()
      })
    }

    promptUser()
  }

  // -- Internal --

  private async executeQuery(prompt: string, resumeSessionId?: string): Promise<TaskResult> {
    const startTime = Date.now()
    let sessionId = resumeSessionId ?? ''
    let turns = 0
    let totalCost = 0
    let finalResult = ''

    const options: ClaudeAgentOptions = {
      permissionMode: this.config.permissionMode === 'bypassPermissions' ? 'bypassPermissions' : 'default',
      model: this.config.claudeModel as 'claude-sonnet-4-20250514' | undefined,
      maxTurns: this.config.maxTurns,
      cwd: this.config.workingDir,
      resumeSessionId,

      // Handle tool permissions and questions with local model
      canUseTool: async (toolName: string, input: Record<string, unknown>) => {
        return this.handleToolRequest(toolName, input, prompt)
      },
    }

    this.emit(`[cc] Starting query with permission mode: ${options.permissionMode}`)
    log.info('claude-code', `Working dir: ${this.config.workingDir}`)

    try {
      for await (const message of query({ prompt, options })) {
        // Handle different message types
        if ('type' in message) {
          switch (message.type) {
            case 'system':
              if ('session_id' in message) {
                sessionId = message.session_id as string
                const model = (message as { model?: string }).model ?? 'unknown'
                this.emit(`[cc] Session ${sessionId.slice(0, 8)}... | Model: ${model}`)
              }
              break

            case 'assistant':
              this.handleAssistantMessage(message)
              break

            case 'result':
              const resultMsg = message as { result?: string; num_turns?: number; total_cost_usd?: number }
              finalResult = resultMsg.result ?? ''
              turns = resultMsg.num_turns ?? turns
              totalCost = resultMsg.total_cost_usd ?? totalCost
              break
          }
        }

        // Track turns from messages that have content
        if ('message' in message && message.message) {
          const msg = message.message as { role?: string }
          if (msg.role === 'assistant') {
            turns++
          }
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      log.error('claude-code', `Query failed: ${msg}`)
      throw error
    }

    return {
      result: finalResult,
      sessionId,
      turns,
      costUsd: totalCost,
      durationMs: Date.now() - startTime,
    }
  }

  /**
   * Handle tool permission requests and AskUserQuestion with local model
   */
  private async handleToolRequest(
    toolName: string,
    input: Record<string, unknown>,
    originalTask: string
  ): Promise<{ behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown>; message?: string }> {

    // Handle AskUserQuestion - Claude is asking for clarification
    if (toolName === 'AskUserQuestion') {
      return this.handleAskUserQuestion(input, originalTask)
    }

    // Handle tool permission requests
    return this.handlePermissionRequest(toolName, input, originalTask)
  }

  /**
   * Use local model to answer Claude's clarifying questions
   */
  private async handleAskUserQuestion(
    input: Record<string, unknown>,
    originalTask: string
  ): Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> }> {
    const questions = input.questions as Array<{
      question: string
      header: string
      options: Array<{ label: string; description: string }>
      multiSelect?: boolean
    }> ?? []

    const answers: Record<string, string> = {}

    for (const q of questions) {
      this.emit(`[cc:question] ${q.header}: ${q.question}`)
      for (const opt of q.options) {
        this.emit(`  - ${opt.label}: ${opt.description}`)
      }

      // Ask local model to answer the question
      const answer = await this.answerQuestionWithLocalModel(originalTask, q)
      answers[q.question] = answer
      this.emit(`[local] ${answer}`)
      this.conversationLog.push(`Q: ${q.question}`, `A: ${answer}`)
    }

    return {
      behavior: 'allow',
      updatedInput: { questions, answers },
    }
  }

  /**
   * Use local model to decide on tool permission requests
   */
  private async handlePermissionRequest(
    toolName: string,
    input: Record<string, unknown>,
    originalTask: string
  ): Promise<{ behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown>; message?: string }> {

    // Format the permission request for display
    const requestSummary = this.formatToolRequest(toolName, input)
    this.emit(`[cc:permission] ${toolName}: ${requestSummary}`)

    // Ask local model if this should be allowed
    const decision = await this.decidePermissionWithLocalModel(originalTask, toolName, input)

    if (decision.allow) {
      this.emit(`[local] Approved: ${decision.reason}`)
      this.conversationLog.push(`Approved ${toolName}: ${decision.reason}`)
      return { behavior: 'allow', updatedInput: input }
    } else {
      this.emit(`[local] Denied: ${decision.reason}`)
      this.conversationLog.push(`Denied ${toolName}: ${decision.reason}`)
      return { behavior: 'deny', message: decision.reason }
    }
  }

  /**
   * Ask local model to answer a clarifying question from Claude
   */
  private async answerQuestionWithLocalModel(
    originalTask: string,
    question: { question: string; options: Array<{ label: string; description: string }>; multiSelect?: boolean }
  ): Promise<string> {
    const optionsList = question.options
      .map((opt, i) => `${i + 1}. ${opt.label}: ${opt.description}`)
      .join('\n')

    const systemPrompt = [
      'You are supervising Claude Code as it works on a task.',
      'It has asked a question and needs your decision.',
      '',
      'Rules:',
      '- Pick the most practical option for the task',
      '- Respond with just the option label (e.g., "Summary" or "Fix all issues")',
      '- If multiple options are allowed, list them comma-separated',
      '- Be decisive - pick what makes most sense for the original task',
      '- If none of the options fit, provide a brief custom answer',
    ].join('\n')

    const userPrompt = [
      `Original task: ${originalTask}`,
      '',
      `Question: ${question.question}`,
      '',
      'Options:',
      optionsList,
      '',
      question.multiSelect ? '(Multiple selections allowed)' : '(Pick one)',
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
        max_tokens: 100,
      })

      return response.content.trim() || question.options[0]?.label || 'Yes'
    } catch (error) {
      log.warn('claude-code', `Local model failed to answer, using first option: ${error}`)
      return question.options[0]?.label || 'Yes'
    }
  }

  /**
   * Ask local model to decide on a permission request
   */
  private async decidePermissionWithLocalModel(
    originalTask: string,
    toolName: string,
    input: Record<string, unknown>
  ): Promise<{ allow: boolean; reason: string }> {
    const recentContext = this.conversationLog.slice(-10).join('\n')
    const inputSummary = this.formatToolRequest(toolName, input)

    const systemPrompt = [
      'You are a security supervisor for Claude Code.',
      'You must decide whether to ALLOW or DENY a tool request.',
      '',
      'Guidelines:',
      '- ALLOW if the action is reasonable for the task and not destructive',
      '- ALLOW reading files, running safe commands (ls, cat, grep, git status, npm test, etc.)',
      '- ALLOW writing/editing files if it\'s part of the task',
      '- DENY destructive commands (rm -rf, drop database, etc.) unless explicitly requested',
      '- DENY accessing sensitive files (/etc/passwd, .env with secrets, ssh keys) unless needed',
      '- DENY network requests to unknown hosts unless part of the task',
      '- When in doubt, ALLOW - Claude Code is generally safe',
      '',
      'Respond in this exact format:',
      'ALLOW: <brief reason>',
      'or',
      'DENY: <brief reason>',
    ].join('\n')

    const userPrompt = [
      `Original task: ${originalTask}`,
      '',
      'Recent activity:',
      recentContext,
      '',
      `Tool: ${toolName}`,
      `Request: ${inputSummary}`,
      '',
      'Your decision (ALLOW or DENY):',
    ].join('\n')

    try {
      const response = await this.localProvider.chat({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.1,
        max_tokens: 100,
      })

      const content = response.content.trim().toUpperCase()

      if (content.startsWith('DENY')) {
        const reason = response.content.replace(/^DENY:?\s*/i, '').trim() || 'Request denied'
        return { allow: false, reason }
      }

      // Default to allow
      const reason = response.content.replace(/^ALLOW:?\s*/i, '').trim() || 'Request approved'
      return { allow: true, reason }
    } catch (error) {
      log.warn('claude-code', `Local model failed to decide, allowing by default: ${error}`)
      return { allow: true, reason: 'Approved (local model unavailable)' }
    }
  }

  /**
   * Format tool input for display
   */
  private formatToolRequest(toolName: string, input: Record<string, unknown>): string {
    switch (toolName) {
      case 'Bash':
        return input.command as string ?? JSON.stringify(input)
      case 'Read':
        return input.file_path as string ?? JSON.stringify(input)
      case 'Write':
      case 'Edit':
        return input.file_path as string ?? JSON.stringify(input)
      case 'Glob':
        return input.pattern as string ?? JSON.stringify(input)
      case 'Grep':
        return input.pattern as string ?? JSON.stringify(input)
      default:
        return JSON.stringify(input).slice(0, 100)
    }
  }

  /**
   * Handle assistant messages for logging
   */
  private handleAssistantMessage(message: unknown): void {
    const msg = message as { message?: { content?: string | Array<{ type: string; text?: string; name?: string; input?: unknown }> } }
    const content = msg.message?.content

    if (!content) return

    if (typeof content === 'string') {
      if (content.trim()) {
        this.emit(`[cc] ${content}`)
        this.conversationLog.push(`Claude: ${content}`)
      }
      return
    }

    for (const block of content) {
      if (block.type === 'text' && block.text) {
        this.emit(`[cc] ${block.text}`)
        this.conversationLog.push(`Claude: ${block.text}`)
      } else if (block.type === 'tool_use' && block.name) {
        this.logToolUse(block.name, block.input as Record<string, unknown>)
      }
    }
  }

  /**
   * Log tool usage for context
   */
  private logToolUse(name: string, input: Record<string, unknown>): void {
    const summary = this.formatToolRequest(name, input)
    this.emit(`[cc:${name.toLowerCase()}] ${summary}`)
    this.conversationLog.push(`${name}: ${summary}`)
  }
}

export function createClaudeCodeChannel(
  localProvider: LLMProvider,
  config: ClaudeCodeConfig,
  emit?: (line: string) => void
): ClaudeCodeChannel {
  return new ClaudeCodeChannel(localProvider, config, emit)
}
