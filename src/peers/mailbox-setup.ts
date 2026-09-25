import { join } from 'node:path'
import type { RuntimeConfig } from '../config'
import type { ConversationStore } from '../conversation/store'
import { parseReportTarget } from '../report/tool'
import { resumeParkedTask } from '../tasks/resume'
import type { OutboundChannel, TaskRunner } from '../tasks/runner'
import type { TaskStore } from '../tasks/store'
import type { ToolExecutor } from '../tools'
import { createDelegateTool } from '../tools/builtin/delegate'
import type { Tool } from '../tools/types'
import { errorMessage } from '../util/errors'
import { log } from '../util/logger'
import { createMailboxClient } from './mailbox'
import { parseMailTarget, pollMailbox } from './mailbox-poll'
import { createMailboxStore } from './mailbox-store'
import { probeWaldAuth, type WaldAuthState } from './wald-auth'

export interface Mailbox {
  poll: () => Promise<string>
  /** Sends a mailbox task's result back to whoever asked, on the thread they asked on. */
  outbound: OutboundChannel
  delegateTool: Tool
}

/**
 * Who may cause work here: the principal, when it is an agent, and peers pinned in [[peers]].
 * Discovered peers are left out on purpose — anyone who can reach Wald can register as one.
 */
export function trustedSenders(config: RuntimeConfig): Set<string> {
  const trusted = new Set(
    (config.peers ?? []).filter((p) => !p.discovered).map((p) => p.name.toLowerCase()),
  )
  const principal = config.report ? parseReportTarget(config.report.to) : undefined
  if (principal?.kind === 'peer') trusted.add(principal.channel.toLowerCase())
  return trusted
}

export interface MailboxSetupOptions {
  config: RuntimeConfig
  toolExecutor: ToolExecutor
  tasks: TaskStore
  runner: TaskRunner
  conversations: ConversationStore | undefined
  /** Where to tell the principal when no report tool is registered. */
  outbound: Map<string, OutboundChannel>
  channel: string
  channelTarget: string
}

export function createMailbox(opts: MailboxSetupOptions): Mailbox | undefined {
  const { config } = opts
  if (!config.mailbox?.enabled) return undefined
  if (!opts.conversations) {
    // The ack rule needs somewhere durable to put every message first.
    log.warn('mailbox', '[mailbox] needs conversation persistence — mailbox NOT enabled')
    return undefined
  }
  const conversations = opts.conversations

  const client = createMailboxClient({
    lookup: (name) => opts.toolExecutor.get(name),
    registry: config.mailbox.registry,
    selfName: config.peerDiscovery?.selfName ?? config.source.instance ?? 'egirl',
  })
  const store = createMailboxStore(join(config.workspace.path, 'mailbox.db'))
  const trusted = trustedSenders(config)
  const cwd = config.workspace.path

  const notifyPrincipal = async (message: string): Promise<void> => {
    try {
      const report = opts.toolExecutor.get('report')
      if (report) {
        const r = await report.execute({ mode: 'notify', message }, cwd)
        if (r.success) return
        log.warn('mailbox', `report notify failed: ${r.output}`)
      }
      const channel = opts.outbound.get(opts.channel)
      if (channel) {
        await channel.send(opts.channelTarget, message)
        return
      }
      log.warn('mailbox', 'No report tool or outbound channel; mailbox notice recorded only')
    } catch (error) {
      log.warn('mailbox', `Could not tell the principal: ${errorMessage(error)}`)
    }
  }

  log.info('mailbox', `Mailbox on (trusted senders: ${[...trusted].join(', ') || 'none'})`)

  // Asked every poll, logged only when it changes: a hub with auth off would otherwise warn
  // every five minutes.
  const registryServer = config.mcp?.servers.find((s) => s.name === config.mailbox?.registry)
  let lastAuth: WaldAuthState | undefined
  const senderVerified = async (): Promise<boolean> => {
    const probe = await probeWaldAuth(registryServer)
    if (probe.state !== lastAuth) {
      lastAuth = probe.state
      if (probe.state === 'on') log.info('mailbox', `Wald authentication on: ${probe.detail}`)
      else
        log.warn(
          'mailbox',
          `Wald authentication ${probe.state} (${probe.detail}) — requests from trusted senders are recorded and reported, not run`,
        )
    }
    return probe.state === 'on'
  }

  return {
    poll: async () =>
      pollMailbox({
        client,
        store,
        tasks: opts.tasks,
        conversations,
        trusted,
        senderVerified: await senderVerified(),
        activateTask: (id) => opts.runner.activateTask(id),
        resume: (sessionId) =>
          resumeParkedTask(
            sessionId,
            opts.tasks,
            opts.runner,
            'Delegation answered in the mailbox — resuming',
          ),
        notifyPrincipal,
      }),
    outbound: {
      async send(target, message) {
        const to = parseMailTarget(target)
        if (!to) throw new Error(`Not a mailbox target: ${target}`)
        const sent = await client.send({
          to: to.agent,
          content: message,
          role: 'response',
          threadId: to.threadId,
        })
        if (!sent.ok) throw new Error(sent.error)
      },
    },
    delegateTool: createDelegateTool({ client, store }),
  }
}
