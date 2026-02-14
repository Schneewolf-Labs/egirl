import type { RuntimeConfig } from '../config'
import { createAgentLoop } from '../agent'
import { createCLIChannel } from '../channels'
import { createAppServices } from '../bootstrap'
import { applyLogLevel } from '../util/args'

export async function runCLI(config: RuntimeConfig, args: string[]): Promise<void> {
  applyLogLevel(args)

  // Check for single message mode
  const messageIndex = args.indexOf('-m')
  const singleMessage = messageIndex !== -1 ? args[messageIndex + 1] : null

  const { providers, memory, conversations, router, toolExecutor, stats } = createAppServices(config)

  // Create agent loop with conversation persistence and memory
  const sessionId = singleMessage ? crypto.randomUUID() : 'cli:default'
  const agent = createAgentLoop({
    config,
    router,
    toolExecutor,
    localProvider: providers.local,
    remoteProvider: providers.remote,
    sessionId,
    memory,
    conversationStore: conversations,
  })

  // Single message mode
  if (singleMessage) {
    try {
      const response = await agent.run(singleMessage)

      stats.recordRequest(
        response.target,
        response.provider,
        response.usage.input_tokens,
        response.usage.output_tokens,
        response.escalated
      )

      console.log(response.content)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`Error: ${message}`)
      process.exit(1)
    }
    return
  }

  // Interactive CLI mode
  const cli = createCLIChannel(agent)
  await cli.start()
}
