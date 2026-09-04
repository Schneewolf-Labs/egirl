import type { AgentLoop } from '../agent'
import { colors, DIM, RESET } from '../ui/theme'
import { createCLIEventHandler } from './cli-events'

export interface CommandContext {
  agent: AgentLoop
  showThinking: boolean
  askApproval: () => Promise<boolean>
}

export async function handlePlanCommand(message: string, ctx: CommandContext): Promise<void> {
  const c = colors()
  try {
    console.log()
    const { handler, state } = createCLIEventHandler(ctx.showThinking)
    const response = await ctx.agent.run(message, {
      events: handler,
      planningMode: true,
    })

    if (!state.streamed && response.content) {
      console.log(`\n${c.secondary}✦ egirl${RESET} ${response.content}\n`)
    }

    if (!response.isPlan) return

    const approved = await ctx.askApproval()
    if (approved) {
      console.log(`\n${c.success}Plan approved.${RESET} Executing...\n`)

      const { handler: execHandler, state: execState } = createCLIEventHandler(ctx.showThinking)
      const execResponse = await ctx.agent.run('Approved. Execute the plan above step by step.', {
        events: execHandler,
        maxTurns: 20,
      })

      if (!execState.streamed && execResponse.content) {
        console.log(`\n${c.secondary}✦ egirl${RESET} ${execResponse.content}\n`)
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
