#!/usr/bin/env bun

import { loadConfig, type EgirlConfig } from './config'
import { createProviderRegistry } from './providers'
import { createModelRouter } from './routing'
import { createDefaultToolExecutor } from './tools'
import { createAgentLoop, createConsoleStreamHandler } from './agent'
import { createCLIChannel } from './channels'
import { createStatsTracker } from './tracking'
import { log } from './utils/logger'

async function main() {
  const args = process.argv.slice(2)
  const command = args[0] ?? 'chat'

  // Load configuration
  let config: EgirlConfig
  try {
    config = loadConfig()
    log.info('main', `Loaded config: workspace=${config.workspace}`)
  } catch (error) {
    console.error('Failed to load config:', error)
    process.exit(1)
  }

  switch (command) {
    case 'chat':
      await runChat(config, args.slice(1))
      break

    case 'status':
      await showStatus(config)
      break

    case 'help':
    case '--help':
    case '-h':
      showHelp()
      break

    default:
      console.error(`Unknown command: ${command}`)
      showHelp()
      process.exit(1)
  }
}

async function runChat(config: EgirlConfig, args: string[]) {
  // Set log level from args
  if (args.includes('--debug') || args.includes('-d')) {
    log.setLevel('debug')
  }

  // Check for single message mode
  const messageIndex = args.indexOf('-m')
  const singleMessage = messageIndex !== -1 ? args[messageIndex + 1] : null

  // Create providers
  const providers = createProviderRegistry(config)

  if (!providers.local) {
    console.error('No local provider configured')
    process.exit(1)
  }

  log.info('main', `Local provider: ${providers.local.name}`)
  if (providers.remote) {
    log.info('main', `Remote provider: ${providers.remote.name}`)
  }

  // Create router and tools
  const router = createModelRouter(config)
  const toolExecutor = createDefaultToolExecutor()

  // Create stats tracker
  const stats = createStatsTracker()

  // Create agent loop
  const agent = createAgentLoop(
    config,
    router,
    toolExecutor,
    providers.local,
    providers.remote
  )

  // Single message mode
  if (singleMessage) {
    try {
      const response = await agent.run(singleMessage, {
        stream: true,
        streamHandler: createConsoleStreamHandler(),
      })

      stats.recordRequest(
        response.model,
        response.provider,
        response.usage.inputTokens,
        response.usage.outputTokens,
        response.escalated
      )

      console.log()  // Newline after streamed response
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`Error: ${message}`)
      process.exit(1)
    }
    return
  }

  // Interactive CLI mode
  const cli = createCLIChannel()

  cli.onMessage(async (message) => {
    // Handle special commands
    if (message.content.toLowerCase() === '/stats') {
      return { content: stats.formatSummary() }
    }

    if (message.content.toLowerCase() === '/clear') {
      agent.clearContext()
      return { content: 'Conversation cleared.' }
    }

    if (message.content.toLowerCase() === '/help') {
      return {
        content: `Commands:
  /stats  - Show usage statistics
  /clear  - Clear conversation history
  /help   - Show this help
  exit    - Quit the program`
      }
    }

    const response = await agent.run(message.content, {
      stream: false,  // CLI handles its own output
    })

    stats.recordRequest(
      response.model,
      response.provider,
      response.usage.inputTokens,
      response.usage.outputTokens,
      response.escalated
    )

    const modelInfo = response.escalated
      ? ` [escalated to ${response.provider}]`
      : ` [${response.provider}]`

    return { content: response.content + modelInfo }
  })

  await cli.start()
}

async function showStatus(config: EgirlConfig) {
  console.log('egirl Status\n')

  console.log('Configuration:')
  console.log(`  Workspace: ${config.workspace}`)
  console.log(`  Local Provider: ${config.local.provider}`)
  console.log(`  Local Model: ${config.local.model}`)
  console.log(`  Local Endpoint: ${config.local.endpoint}`)

  if (config.remote.anthropic) {
    console.log(`  Remote (Anthropic): ${config.remote.anthropic.defaultModel}`)
  }
  if (config.remote.openai) {
    console.log(`  Remote (OpenAI): ${config.remote.openai.defaultModel}`)
  }

  console.log(`\nRouting:`)
  console.log(`  Default Model: ${config.routing.defaultModel}`)
  console.log(`  Escalation Threshold: ${config.routing.escalationThreshold}`)
  console.log(`  Always Local: ${config.routing.alwaysLocal.join(', ')}`)
  console.log(`  Always Remote: ${config.routing.alwaysRemote.join(', ')}`)

  // Test local provider connection
  console.log('\nProvider Status:')
  try {
    const providers = createProviderRegistry(config)
    if (providers.local) {
      const testResponse = await providers.local.chat({
        messages: [{ role: 'user', content: 'Say "ok" and nothing else.' }],
      })
      console.log(`  Local: Connected (${testResponse.model})`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.log(`  Local: Error - ${message}`)
  }
}

function showHelp() {
  console.log(`
egirl - Local-First AI Agent Framework

Usage:
  egirl [command] [options]

Commands:
  chat      Start interactive chat (default)
  status    Show current configuration and status
  help      Show this help message

Options for chat:
  -m <msg>  Send a single message and exit
  -d, --debug  Enable debug logging

Examples:
  egirl chat              # Start interactive chat
  egirl chat -m "Hello"   # Send a single message
  egirl status            # Show status
`)
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
