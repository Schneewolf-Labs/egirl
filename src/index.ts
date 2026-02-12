#!/usr/bin/env bun

import { loadConfig, type RuntimeConfig } from './config'
import { createProviderRegistry } from './providers'
import { createRouter } from './routing'
import { createDefaultToolExecutor } from './tools'
import { createAgentLoop } from './agent'
import { createCLIChannel } from './channels'
import { createStatsTracker } from './tracking'
import { log } from './util/logger'

async function main() {
  const args = process.argv.slice(2)
  const command = args[0] ?? 'cli'

  // Load configuration
  let config: RuntimeConfig
  try {
    config = loadConfig()
    log.info('main', `Loaded config: workspace=${config.workspace.path}`)
  } catch (error) {
    console.error('Failed to load config:', error)
    process.exit(1)
  }

  switch (command) {
    case 'cli':
      await runCLI(config, args.slice(1))
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

async function runCLI(config: RuntimeConfig, args: string[]) {
  // Set log level from args
  if (args.includes('--quiet') || args.includes('-q')) {
    log.setLevel('error')
  } else if (args.includes('--verbose') || args.includes('-v') || args.includes('--debug') || args.includes('-d')) {
    log.setLevel('debug')
  }

  // Check for single message mode
  const messageIndex = args.indexOf('-m')
  const singleMessage = messageIndex !== -1 ? args[messageIndex + 1] : null

  // Create providers
  const providers = createProviderRegistry(config)

  log.info('main', `Local provider: ${providers.local.name}`)
  if (providers.remote) {
    log.info('main', `Remote provider: ${providers.remote.name}`)
  }

  // Create router and tools
  const router = createRouter(config)
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

async function showStatus(config: RuntimeConfig) {
  console.log('egirl Status\n')

  console.log('Configuration:')
  console.log(`  Workspace: ${config.workspace.path}`)
  console.log(`  Local Model: ${config.local.model}`)
  console.log(`  Local Endpoint: ${config.local.endpoint}`)

  if (config.remote.anthropic) {
    console.log(`  Remote (Anthropic): ${config.remote.anthropic.model}`)
  }
  if (config.remote.openai) {
    console.log(`  Remote (OpenAI): ${config.remote.openai.model}`)
  }

  console.log(`\nRouting:`)
  console.log(`  Default: ${config.routing.default}`)
  console.log(`  Escalation Threshold: ${config.routing.escalationThreshold}`)
  console.log(`  Always Local: ${config.routing.alwaysLocal.join(', ')}`)
  console.log(`  Always Remote: ${config.routing.alwaysRemote.join(', ')}`)

  // Test local provider connection
  console.log('\nProvider Status:')
  try {
    const providers = createProviderRegistry(config)
    const testResponse = await providers.local.chat({
      messages: [{ role: 'user', content: 'Say "ok" and nothing else.' }],
    })
    console.log(`  Local: Connected (${testResponse.model})`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.log(`  Local: Error - ${message}`)
  }
}

function showHelp() {
  console.log(`
egirl - Local-First AI Agent for Schneewolf Labs

Usage:
  egirl [command] [options]

Commands:
  cli       Start interactive CLI (default)
  status    Show current configuration and status
  help      Show this help message

Options for cli:
  -m <msg>     Send a single message and exit
  -v, --verbose  Enable verbose/debug logging
  -d, --debug    Alias for --verbose
  -q, --quiet    Only show errors

Examples:
  bun run dev           # Start with --watch
  bun run start         # Production start
  bun run cli           # Direct CLI mode
`)
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
