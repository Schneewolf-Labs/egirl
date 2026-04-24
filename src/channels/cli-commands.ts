import type { AgentLoop } from '../agent'
import type { ThinkingConfig } from '../providers/types'
import { colors, DIM, RESET } from '../ui/theme'
import { createCLIEventHandler } from './cli-events'

const THINKING_LEVELS = ['off', 'low', 'medium', 'high'] as const

export interface CommandContext {
  agent: AgentLoop
  showThinking: boolean
  /** Mutable holder for the thinking override — /think mutates `.current`. */
  thinkingOverride: { current: ThinkingConfig | undefined }
  askApproval: () => Promise<boolean>
}

export function handleThinkCommand(input: string, ctx: CommandContext): void {
  const c = colors()
  const level = input.split(/\s+/)[1]?.toLowerCase()

  if (!level) {
    const current = ctx.thinkingOverride.current?.level ?? 'config default'
    console.log(`\n${c.info}Thinking level:${RESET} ${current}`)
    console.log(`${DIM}Usage: /think <off|low|medium|high>${RESET}\n`)
    return
  }

  if (!THINKING_LEVELS.includes(level as (typeof THINKING_LEVELS)[number])) {
    console.log(`\n${c.error}Invalid thinking level:${RESET} ${level}`)
    console.log(`${DIM}Valid levels: off, low, medium, high${RESET}\n`)
    return
  }

  const thinkingLevel = level as ThinkingConfig['level']
  ctx.thinkingOverride.current =
    thinkingLevel === 'off' ? { level: 'off' } : { level: thinkingLevel }
  if (thinkingLevel === 'off') {
    console.log(`\n${c.muted}Thinking disabled${RESET}\n`)
  } else {
    console.log(`\n${c.success}Thinking level set to ${thinkingLevel}${RESET}\n`)
  }
}

export async function handlePlanCommand(message: string, ctx: CommandContext): Promise<void> {
  const c = colors()
  try {
    console.log()
    const { handler, state } = createCLIEventHandler(ctx.showThinking)
    const response = await ctx.agent.run(message, {
      events: handler,
      thinking: ctx.thinkingOverride.current,
      planningMode: true,
    })

    if (!state.streamed && response.content) {
      console.log(`\n${c.secondary}egirl>${RESET} ${response.content}\n`)
    }

    if (!response.isPlan) return

    const approved = await ctx.askApproval()
    if (approved) {
      console.log(`\n${c.success}Plan approved.${RESET} Executing...\n`)

      const { handler: execHandler, state: execState } = createCLIEventHandler(ctx.showThinking)
      const execResponse = await ctx.agent.run('Approved. Execute the plan above step by step.', {
        events: execHandler,
        thinking: ctx.thinkingOverride.current,
        maxTurns: 20,
      })

      if (!execState.streamed && execResponse.content) {
        console.log(`\n${c.secondary}egirl>${RESET} ${execResponse.content}\n`)
      }
    } else {
      console.log(
        `\n${c.warning}Plan rejected.${RESET} You can modify your request and try again.\n`,
      )
      ctx.agent
        .run('[User rejected the plan. Awaiting new instructions.]', { maxTurns: 1 })
        .catch(() => {})
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    console.error(`\n${c.error}Error:${RESET} ${errorMessage}\n`)
  }
}

export async function handleContextCommand(ctx: CommandContext): Promise<void> {
  const c = colors()
  try {
    const status = await ctx.agent.contextStatus()
    const pct = Math.round(status.utilization * 100)

    let barColor = c.success
    if (pct > 80) barColor = c.error
    else if (pct > 60) barColor = c.warning

    const barWidth = 30
    const filled = Math.round((pct / 100) * barWidth)
    const bar = `${barColor}${'█'.repeat(filled)}${DIM}${'░'.repeat(barWidth - filled)}${RESET}`

    console.log(`\n${c.primary}Context Window${RESET}`)
    console.log(`  ${bar} ${barColor}${pct}%${RESET}`)
    console.log(`${DIM}  Session:        ${status.sessionId}${RESET}`)
    console.log(`${DIM}  Budget:         ${status.contextLength.toLocaleString()} tokens${RESET}`)
    console.log(`${DIM}  System prompt:  ~${status.systemPromptTokens.toLocaleString()}t${RESET}`)
    console.log(
      `${DIM}  Messages:       ${status.messageCount} (~${status.messageTokens.toLocaleString()}t)${RESET}`,
    )
    if (status.hasSummary) {
      console.log(
        `${DIM}  Summary:        ~${status.summaryTokens.toLocaleString()}t (compacted)${RESET}`,
      )
    }
    console.log(`${DIM}  Available:      ~${status.available.toLocaleString()}t${RESET}\n`)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error(`${c.error}Failed to get context status:${RESET} ${msg}\n`)
  }
}

export async function handleCompactCommand(ctx: CommandContext): Promise<void> {
  const c = colors()
  try {
    const result = await ctx.agent.compactNow()
    if (result.messagesBefore === result.messagesAfter) {
      console.log(`\n${c.muted}Nothing to compact (${result.messagesBefore} messages).${RESET}\n`)
    } else {
      const dropped = result.messagesBefore - result.messagesAfter
      console.log(
        `\n${c.success}Compacted:${RESET} ${dropped} messages summarized, ${result.messagesAfter} kept.\n`,
      )
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error(`${c.error}Compaction failed:${RESET} ${msg}\n`)
  }
}

export function handlePromptCommand(ctx: CommandContext): void {
  const c = colors()
  const agentCtx = ctx.agent.getContext()
  console.log(
    `\n${c.primary}System Prompt${RESET} ${DIM}(${agentCtx.systemPrompt.length} chars)${RESET}\n`,
  )
  console.log(`${DIM}${'─'.repeat(60)}${RESET}`)
  console.log(agentCtx.systemPrompt)
  console.log(`${DIM}${'─'.repeat(60)}${RESET}\n`)
}

export function handleDebugCommand(ctx: CommandContext): void {
  const c = colors()
  const agentCtx = ctx.agent.getContext()

  console.log(`\n${c.primary}Debug Info${RESET}\n`)
  console.log(`${c.accent}Session${RESET}`)
  console.log(`${DIM}  id:       ${agentCtx.sessionId}${RESET}`)
  console.log(`${DIM}  messages: ${agentCtx.messages.length}${RESET}`)
  console.log(`${DIM}  prompt:   ${agentCtx.systemPrompt.length} chars${RESET}`)

  console.log(`\n${c.accent}Messages${RESET}`)
  for (const [i, msg] of agentCtx.messages.entries()) {
    const content =
      typeof msg.content === 'string'
        ? msg.content.slice(0, 80).replace(/\n/g, ' ')
        : JSON.stringify(msg.content).slice(0, 80)
    console.log(
      `${DIM}  [${i}] ${msg.role}: ${content}${content.length >= 80 ? '...' : ''}${RESET}`,
    )
  }
  console.log()
}

export function handleWipeCommand(ctx: CommandContext): void {
  const c = colors()
  ctx.agent.resetSession()
  console.clear()
  console.log(`${c.muted}Session wiped.${RESET}\n`)
}
