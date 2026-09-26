import type { MailboxClient } from '../../peers/mailbox'
import type { MailboxStore } from '../../peers/mailbox-store'
import type { Tool, ToolCallContext, ToolResult } from '../types'

export interface DelegateToolDeps {
  client: MailboxClient
  store: MailboxStore
}

/**
 * Hand work to another agent through the Wald mailbox and stop waiting on it.
 *
 * The asynchronous sibling of peer_message: the other agent need not be up, and need not be
 * an egirl. Called from a task, the run parks as `awaiting` — the same state an unanswered
 * report ask leaves — and the mailbox poll resumes it when the answer lands on the thread.
 */
export function createDelegateTool(deps: DelegateToolDeps): Tool {
  return {
    definition: {
      name: 'delegate',
      description:
        "Hand a piece of work to another agent through the Wald mailbox (any registered agent, not only egirl peers). Doesn't wait: the agent may be offline and pick it up later. " +
        'From a background task, end the run after calling this — the task is parked and resumes with the answer when it arrives. ' +
        'From a conversation, the answer is passed on to your principal when it arrives. ' +
        'Use peer_message instead when you need the answer now from a peer that is up.',
      parameters: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: "The agent's Wald slug" },
          message: {
            type: 'string',
            description:
              'The work, self-contained: the agent sees none of your context. Say what done looks like.',
          },
        },
        required: ['agent', 'message'],
      },
    },

    async execute(
      params: Record<string, unknown>,
      _cwd: string,
      ctx?: ToolCallContext,
    ): Promise<ToolResult> {
      const agent = (params.agent as string | undefined)?.trim()
      const message = (params.message as string | undefined)?.trim()
      if (!agent || !message) return { success: false, output: 'agent and message are required' }
      if (!ctx?.sessionId) {
        return {
          success: false,
          output: 'delegate needs a session to route the answer back to, and this call has none.',
        }
      }

      // Record before sending, on a thread id chosen here: an answer cannot arrive for a
      // thread this instance has no record of, however fast the other side is.
      const threadId = crypto.randomUUID()
      deps.store.recordDelegation({ threadId, sessionId: ctx.sessionId, agent, request: message })

      const sent = await deps.client.send({
        to: agent,
        content: message,
        role: 'request',
        threadId,
      })
      if (!sent.ok) {
        deps.store.forgetDelegation(threadId)
        return { success: false, output: `Could not delegate to ${agent}: ${sent.error}` }
      }

      if (ctx.sessionId.startsWith('task:')) {
        return {
          success: true,
          output: `Delegated to ${agent} (thread ${threadId}). Save your state to durable notes and end the run — the task is parked until ${agent} answers, and the answer will seed the next run.`,
          awaitingInput: true,
        }
      }
      return {
        success: true,
        output: `Delegated to ${agent} (thread ${threadId}). The answer will be passed to your principal when it arrives; carry on.`,
      }
    },
  }
}
