import { postPeerMessage } from '../peers/client'
import type { PeerEntry } from '../peers/protocol'
import type { Tool, ToolResult } from '../tools/types'
import { log } from '../util/logger'
import type { ReplyBroker } from './broker'

/**
 * The report tool — the agent's line to its supervisor (docs/autonomy-loop.md, Phase 2).
 *
 * One tool, two modes, one configured target. `ask` blocks until the supervisor answers;
 * `notify` sends and returns immediately. The target is fixed by config — an agent does not
 * choose who supervises it — and can be another egirl (`peer:<name>`, riding the peer
 * protocol's existing await machinery) or a human on a chat channel (`<channel>:<target>`,
 * riding the outbound send plus the ReplyBroker for the blocking half). A human is just a
 * slow peer: same contract, different latency.
 */

export interface ReportTarget {
  kind: 'peer' | 'channel'
  /** Peer name for kind=peer; outbound channel name (discord, xmpp) for kind=channel. */
  channel: string
  /** Channel-specific target (JID, channel ID). Empty for kind=peer. */
  target: string
}

/** Parse a `report.to` string: `peer:hermes`, `xmpp:nick@example.com`, `discord:12345`. */
export function parseReportTarget(to: string): ReportTarget | undefined {
  const idx = to.indexOf(':')
  if (idx <= 0 || idx === to.length - 1) return undefined
  const head = to.slice(0, idx).toLowerCase()
  const rest = to.slice(idx + 1)
  if (head === 'peer') return { kind: 'peer', channel: rest, target: '' }
  return { kind: 'channel', channel: head, target: rest }
}

export interface ReportToolDeps {
  /** Parsed report.to target. */
  to: ReportTarget
  /** The raw config string, for tool description and error messages. */
  toRaw: string
  /** How this instance identifies itself when reporting. */
  selfName: string
  /** Configured peers, for kind=peer targets. */
  peers: PeerEntry[]
  /** Outbound channels by name, for kind=channel targets. */
  outbound: Map<string, { send(target: string, message: string): Promise<void> }>
  /** Reply broker for blocking asks on human channels. Absent = ask unsupported there. */
  broker?: ReplyBroker
  /** Default wait for mode=ask, ms. */
  askTimeoutMs: number
}

export function createReportTool(deps: ReportToolDeps): Tool {
  const { to, toRaw, selfName } = deps

  return {
    definition: {
      name: 'report',
      description:
        `Report to your supervisor (${toRaw}). Two modes:\n` +
        '- "ask": send a question and WAIT for the reply, which is returned to you. Use when you are blocked on a decision you cannot make yourself, or when your goal is exhausted and you need direction on what to do next. Being blocked is a signal to report, not a failure.\n' +
        '- "notify": send a one-way update and continue immediately. Use for significant milestones and for announcing a final result before ending your run.\n' +
        'Your supervisor does not see your conversation — make the message self-contained, with enough context to act on.',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            description: '"ask" (blocking, returns the reply) or "notify" (one-way)',
          },
          message: { type: 'string', description: 'The report. Specific and self-contained.' },
          timeout_ms: {
            type: 'number',
            description: `ask only: max wait for the reply (default ${deps.askTimeoutMs}ms)`,
          },
        },
        required: ['mode', 'message'],
      },
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const mode = params.mode as string | undefined
      const message = params.message as string | undefined
      if (mode !== 'ask' && mode !== 'notify') {
        return { success: false, output: 'mode must be "ask" or "notify"' }
      }
      if (!message?.trim()) {
        return { success: false, output: 'message is required' }
      }
      const timeoutMs = (params.timeout_ms as number | undefined) ?? deps.askTimeoutMs

      if (to.kind === 'peer') {
        const peer = deps.peers.find((p) => p.name.toLowerCase() === to.channel.toLowerCase())
        if (!peer) {
          return {
            success: false,
            output: `Report target ${toRaw} is not among the configured peers.`,
          }
        }
        const framed = `[report:${mode}] From ${selfName}, reporting to you as supervisor.\n\n${message}`
        if (mode === 'notify') {
          // One-way by contract: the supervisor's agent still runs, but this run does not
          // wait on it. Delivery failures are logged, not surfaced — a notify must not block.
          postPeerMessage(peer, selfName, framed, peer.timeoutMs)
            .then((r) => {
              if (!r.ok) log.warn('report', `notify to ${toRaw} failed: ${r.error}`)
            })
            .catch((e) => log.warn('report', `notify to ${toRaw} failed: ${e}`))
          return { success: true, output: `Report sent to ${peer.name}.` }
        }
        const result = await postPeerMessage(peer, selfName, framed, timeoutMs)
        if (!result.ok) {
          return {
            success: false,
            output: result.timedOut
              ? `${result.error}\nNo answer within the wait window. Save your state to durable notes and end the run — it will be parked as awaiting input, and the reply will seed the next run.`
              : result.error,
            ...(result.timedOut && { awaitingInput: true }),
          }
        }
        return { success: true, output: `${result.from} replied:\n\n${result.content}` }
      }

      // Human channel target
      const channel = deps.outbound.get(to.channel)
      if (!channel) {
        return {
          success: false,
          output: `Report target ${toRaw} is configured but channel "${to.channel}" is not connected in this process.`,
        }
      }
      const framed = `[report from ${selfName}]${mode === 'ask' ? ' (awaiting your reply)' : ''}\n${message}`
      if (mode === 'notify') {
        try {
          await channel.send(to.target, framed)
          return { success: true, output: `Report sent to ${toRaw}.` }
        } catch (e) {
          return { success: false, output: `Failed to send report to ${toRaw}: ${e}` }
        }
      }
      if (!deps.broker) {
        return {
          success: false,
          output: `mode=ask is not available: channel "${to.channel}" has no reply broker in this process. Use mode=notify and end the run; the reply can arrive as a normal message.`,
        }
      }
      // Park BEFORE sending so a fast reply cannot race past the broker.
      const reply = deps.broker.awaitReply(to.channel, to.target, timeoutMs)
      try {
        await channel.send(to.target, framed)
      } catch (e) {
        return { success: false, output: `Failed to send report to ${toRaw}: ${e}` }
      }
      const answer = await reply
      if (answer === undefined) {
        return {
          success: false,
          output:
            `No reply from ${toRaw} within ${timeoutMs}ms. ` +
            'Save your state to durable notes and end the run — it will be parked as awaiting input, and the reply will seed the next run.',
          awaitingInput: true,
        }
      }
      return { success: true, output: `Supervisor replied:\n\n${answer}` }
    },
  }
}
