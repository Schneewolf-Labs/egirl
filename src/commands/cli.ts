import { createAgentLoop } from '../agent'
import { SessionMutex } from '../agent/session-mutex'
import { createAppServices } from '../bootstrap'
import { createCLIChannel } from '../channels'
import type { RuntimeConfig } from '../config'
import { gatherStandup } from '../standup'
import {
  createDiscovery,
  createTaskRunner,
  seedHeartbeatTask,
  taskRunnerEnabled,
  taskRunnerOffReason,
} from '../tasks'
import { createTaskTools } from '../tools/builtin/tasks'
import type { ToolResult } from '../tools/types'
import { applyLogLevel } from '../util/args'
import { log } from '../util/logger'

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

  const {
    providers,
    memory,
    conversations,
    taskStore,
    toolExecutor,
    stats,
    transcript,
    skills,
    processRegistry,
  } = await createAppServices(config)

  // Gather workspace standup for agent context
  const standup = await gatherStandup(config.workspace.path)

  // Shared mutex serializes agent runs across CLI input and background tasks
  const sessionMutex = new SessionMutex()

  // Create agent loop with conversation persistence and memory
  const sessionId = singleMessage ? crypto.randomUUID() : 'cli:default'
  const agent = createAgentLoop({
    config,
    toolExecutor,
    localProvider: providers.local,
    sessionId,
    memory,
    conversationStore: conversations,
    transcript,
    skills,
    additionalContext: standup.context || undefined,
    sessionMutex,
  })

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
  const cli = createCLIChannel(agent, { showThinking: config.thinking.showThinking })

  // Set up background task runner if task store is available
  let taskRunner: ReturnType<typeof createTaskRunner> | undefined
  let discovery: ReturnType<typeof createDiscovery> | undefined

  if (taskRunnerEnabled(config, !!taskStore) && taskStore) {
    const outbound = new Map<string, { send(target: string, message: string): Promise<void> }>()
    outbound.set('cli', cli)

    taskRunner = createTaskRunner({
      config,
      tasksConfig: config.tasks,
      store: taskStore,
      toolExecutor,
      localProvider: providers.local,
      memory,
      transcript,
      outbound,
      conversationStore: conversations,
      sessionMutex,
    })

    // Register task tools on the shared tool executor
    const taskTools = createTaskTools(taskStore, taskRunner, config.tasks.maxActiveTasks, () => ({
      channel: 'cli',
      channelTarget: 'stdout',
    }))
    toolExecutor.registerAll([
      taskTools.taskAddTool,
      taskTools.taskProposeTool,
      taskTools.taskListTool,
      taskTools.taskPauseTool,
      taskTools.taskResumeTool,
      taskTools.taskCancelTool,
      taskTools.taskRunNowTool,
      taskTools.taskHistoryTool,
    ])

    // Set up discovery if enabled
    if (config.tasks.discoveryEnabled) {
      discovery = createDiscovery({
        config,
        tasksConfig: config.tasks,
        store: taskStore,
        runner: taskRunner,
        toolExecutor,
        localProvider: providers.local,
        memory,
        transcript,
      })
    }

    // Seed built-in heartbeat task if enabled
    seedHeartbeatTask({
      store: taskStore,
      runner: taskRunner,
      tasksConfig: config.tasks,
      heartbeatConfig: config.tasks.heartbeat,
      workspacePath: config.workspace.path,
      channel: 'cli',
      channelTarget: 'stdout',
    })

    log.info('main', 'Background task system initialized')
  } else {
    // Say WHY, naming the flag. A bare silence here means a populated [tasks] section that
    // simply never runs, which is exactly what happened in practice.
    const why = taskRunnerOffReason(config, !!taskStore)
    if (config.source.tasksConfiguredButGated) {
      log.warn('tasks', `[tasks] is configured but INERT: ${why}`)
    } else if (why) {
      log.info('tasks', `Background tasks off: ${why}`)
    }
  }

  // Handle graceful shutdown
  const shutdown = async () => {
    log.info('main', 'Shutting down...')
    discovery?.stop()
    taskRunner?.stop()
    await cli.stop()
    await processRegistry.shutdownAll()
    taskStore?.close()
    conversations?.close()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await cli.start()

  // Start task runner and discovery after CLI is ready
  taskRunner?.start()
  discovery?.start()
}
