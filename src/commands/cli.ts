import { createCLIChannel } from '../channels'
import type { OutboundChannel } from '../channels/types'
import type { RuntimeConfig } from '../config'
import type { ToolResult } from '../tools/types'
import { applyLogLevel } from '../util/args'
import { createBackgroundTasks, createCommandRuntime, onShutdown } from './runtime'

export async function runCLI(config: RuntimeConfig, args: string[]): Promise<void> {
  applyLogLevel(args)

  // Check for single message mode
  const messageIndex = args.indexOf('-m')
  const singleMessage = messageIndex !== -1 ? args[messageIndex + 1] : null
  // --json makes single-message mode machine-readable: one JSON object on stdout and nothing
  // else. Without it the only way to check what egirl did is to scrape ANSI-coloured log lines,
  // which is too lossy to build an eval harness on — you can see the final text but not which
  // tools were called, with what arguments, or whether they succeeded. Those are the things
  // worth measuring about an operator model.
  const asJson = args.includes('--json')

  const rt = await createCommandRuntime(config)
  const { conversations, taskStore, stats, processRegistry } = rt

  // Create agent loop with conversation persistence and memory
  const agent = rt.agentFactory(singleMessage ? crypto.randomUUID() : 'cli:default')

  // Single message mode — no task runner
  if (singleMessage) {
    // Record every tool call and its outcome. An operator model is judged on what it *did*, not
    // just what it said, and a run that answers correctly by calling the wrong tool is a failure
    // that plain text output cannot show.
    const toolCalls: Array<{
      name: string
      arguments: unknown
      ok?: boolean
      error?: string
      ms?: number
    }> = []
    const startedAt = new Map<string, number>()

    const events = asJson
      ? {
          onToolCallStart(calls: { id?: string; name: string; arguments?: unknown }[]) {
            for (const call of calls) {
              startedAt.set(call.id ?? call.name, Date.now())
              toolCalls.push({ name: call.name, arguments: call.arguments })
            }
          },
          onToolCallComplete(callId: string, name: string, result: ToolResult) {
            const started = startedAt.get(callId) ?? startedAt.get(name)
            // Match the most recent unresolved entry for this tool: ids are not guaranteed
            // to be present on every provider dialect.
            const entry = [...toolCalls]
              .reverse()
              .find((t) => t.name === name && t.ok === undefined)
            if (entry) {
              entry.ok = result.success
              // A failed tool's output is the error message; keep a short prefix so a bench can
              // tell "wrong arguments" apart from "tool blew up".
              if (!result.success) entry.error = result.output?.slice(0, 500)
              if (started) entry.ms = Date.now() - started
            }
          },
        }
      : undefined

    const t0 = Date.now()
    try {
      const response = await agent.run(singleMessage, events ? { events } : undefined)

      stats.recordRequest(
        response.provider,
        response.usage.input_tokens,
        response.usage.output_tokens,
      )

      if (asJson) {
        // Exactly one JSON object on stdout, nothing else — logs go to stderr, so a caller can
        // safely do `egirl cli -m "..." --json 2>/dev/null | jq`.
        process.stdout.write(
          `${JSON.stringify({
            ok: true,
            message: singleMessage,
            response: response.content,
            thinking: response.thinking ?? null,
            tool_calls: toolCalls,
            turns: response.turns,
            provider: response.provider,
            usage: response.usage,
            elapsed_ms: Date.now() - t0,
          })}\n`,
        )
      } else {
        console.log(response.content)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (asJson) {
        process.stdout.write(
          `${JSON.stringify({
            ok: false,
            message: singleMessage,
            error: message,
            tool_calls: toolCalls,
            elapsed_ms: Date.now() - t0,
          })}\n`,
        )
      } else {
        console.error(`Error: ${message}`)
      }
      process.exit(1)
    }
    return
  }

  // Interactive CLI mode
  const cli = createCLIChannel(agent, {
    showThinking: config.thinking.showThinking,
    skillsDir: config.skills.dirs[0],
  })

  const tasks = createBackgroundTasks(rt, {
    outbound: new Map<string, OutboundChannel>([['cli', cli]]),
    channel: 'cli',
    channelTarget: 'stdout',
  })

  onShutdown(async () => {
    tasks?.discovery?.stop()
    tasks?.taskRunner.stop()
    await cli.stop()
    await processRegistry.shutdownAll()
    taskStore?.close()
    conversations?.close()
  })

  await cli.start()

  // Start task runner and discovery after CLI is ready
  tasks?.taskRunner.start()
  tasks?.discovery?.start()
}
