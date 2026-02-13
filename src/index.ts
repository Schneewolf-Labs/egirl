#!/usr/bin/env bun

import { loadConfig, type RuntimeConfig } from './config'
import { createProviderRegistry } from './providers'
import { createRouter } from './routing'
import { createDefaultToolExecutor } from './tools'
import { createAgentLoop } from './agent'
import { createCLIChannel, createClaudeCodeChannel, createDiscordChannel, type ClaudeCodeConfig } from './channels'
import { createStatsTracker } from './tracking'
import { createMemoryManager, Qwen3VLEmbeddings, type MemoryManager } from './memory'
import { createAPIServer } from './api'
import { bootstrapWorkspace } from './workspace/bootstrap'
import { log } from './util/logger'

/**
 * Create memory manager with embeddings if configured
 */
function createMemory(config: RuntimeConfig): MemoryManager | undefined {
  const embeddingsConfig = config.local.embeddings
  if (!embeddingsConfig) {
    log.info('main', 'No embeddings configured - memory system disabled')
    return undefined
  }

  try {
    // Create embedding provider (using Qwen3-VL by default)
    const embeddings = new Qwen3VLEmbeddings(
      embeddingsConfig.endpoint,
      embeddingsConfig.dimensions
    )

    const memory = createMemoryManager({
      workspaceDir: config.workspace.path,
      embeddings,
      embeddingDimensions: embeddingsConfig.dimensions,
    })

    log.info('main', `Memory system initialized: ${embeddingsConfig.model} @ ${embeddingsConfig.endpoint}`)
    return memory
  } catch (error) {
    log.warn('main', 'Failed to initialize memory system:', error)
    return undefined
  }
}

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

  // Bootstrap workspace (copy templates if needed)
  try {
    await bootstrapWorkspace(config.workspace.path)
  } catch (error) {
    log.warn('main', 'Failed to bootstrap workspace:', error)
  }

  switch (command) {
    case 'cli':
      await runCLI(config, args.slice(1))
      break

    case 'status':
      await showStatus(config)
      break

    case 'claude-code':
    case 'cc':
      await runClaudeCode(config, args.slice(1))
      break

    case 'discord':
      await runDiscord(config, args.slice(1))
      break

    case 'api':
      await runAPI(config, args.slice(1))
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

  // Create memory system (if embeddings configured)
  const memory = createMemory(config)

  // Create router and tools
  const router = createRouter(config)
  const toolExecutor = createDefaultToolExecutor(memory)

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

  if (config.local.embeddings) {
    console.log(`  Embeddings: ${config.local.embeddings.model} @ ${config.local.embeddings.endpoint}`)
    console.log(`    Dimensions: ${config.local.embeddings.dimensions}, Multimodal: ${config.local.embeddings.multimodal}`)
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

  // Test embeddings service
  if (config.local.embeddings) {
    try {
      const response = await fetch(`${config.local.embeddings.endpoint}/health`)
      if (response.ok) {
        const health = await response.json() as { status: string; device: string }
        console.log(`  Embeddings: Connected (${health.device})`)
      } else {
        console.log(`  Embeddings: Error - ${response.status}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.log(`  Embeddings: Error - ${message}`)
    }
  }
}

async function runClaudeCode(config: RuntimeConfig, args: string[]) {
  // Set log level from args
  if (args.includes('--quiet') || args.includes('-q')) {
    log.setLevel('error')
  } else if (args.includes('--verbose') || args.includes('-v') || args.includes('--debug') || args.includes('-d')) {
    log.setLevel('debug')
  }

  const providers = createProviderRegistry(config)

  const ccConfig: ClaudeCodeConfig = {
    permissionMode: config.channels.claudeCode?.permissionMode ?? 'bypassPermissions',
    claudeModel: config.channels.claudeCode?.model,
    workingDir: config.channels.claudeCode?.workingDir ?? process.cwd(),
    maxTurns: config.channels.claudeCode?.maxTurns,
  }

  const channel = createClaudeCodeChannel(providers.local, ccConfig)

  // Single task mode
  const messageIndex = args.indexOf('-m')
  if (messageIndex !== -1) {
    const prompt = args[messageIndex + 1]
    if (!prompt) {
      console.error('Error: -m requires a message')
      process.exit(1)
    }

    try {
      const result = await channel.runTask(prompt)
      console.log(`\n${result.result}`)
      console.log(`\n[${result.turns} turns | $${result.costUsd.toFixed(4)} | ${(result.durationMs / 1000).toFixed(1)}s]`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`Error: ${message}`)
      process.exit(1)
    }
    return
  }

  // Resume mode
  const resumeIndex = args.indexOf('--resume')
  if (resumeIndex !== -1) {
    const sessionId = args[resumeIndex + 1] as string | undefined
    if (!sessionId) {
      console.error('Error: --resume requires a session ID')
      process.exit(1)
      return
    }

    const promptIdx = args.indexOf('-m', resumeIndex + 2)
    const followUp = promptIdx !== -1 ? (args[promptIdx + 1] ?? 'Continue.') : 'Continue the previous task.'

    try {
      const result = await channel.resumeSession(sessionId, followUp)
      console.log(`\n${result.result}`)
      console.log(`\n[${result.turns} turns | $${result.costUsd.toFixed(4)} | ${(result.durationMs / 1000).toFixed(1)}s]`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`Error: ${message}`)
      process.exit(1)
    }
    return
  }

  // Interactive mode
  await channel.startInteractive()
}

async function runDiscord(config: RuntimeConfig, args: string[]) {
  // Set log level from args
  if (args.includes('--quiet') || args.includes('-q')) {
    log.setLevel('error')
  } else if (args.includes('--verbose') || args.includes('-v') || args.includes('--debug') || args.includes('-d')) {
    log.setLevel('debug')
  }

  // Check Discord config
  if (!config.channels.discord) {
    console.error('Error: Discord not configured. Add DISCORD_TOKEN to .env and configure channels.discord in egirl.toml')
    process.exit(1)
  }

  // Create providers
  const providers = createProviderRegistry(config)

  log.info('main', `Local provider: ${providers.local.name}`)
  if (providers.remote) {
    log.info('main', `Remote provider: ${providers.remote.name}`)
  }

  // Create memory system
  const memory = createMemory(config)

  // Create router and tools
  const router = createRouter(config)
  const toolExecutor = createDefaultToolExecutor(memory)

  // Create agent loop
  const agent = createAgentLoop(
    config,
    router,
    toolExecutor,
    providers.local,
    providers.remote
  )

  // Create and start Discord channel
  const discord = createDiscordChannel(agent, config.channels.discord)

  // Handle graceful shutdown
  const shutdown = async () => {
    log.info('main', 'Shutting down...')
    await discord.stop()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await discord.start()

  // Keep alive
  log.info('main', 'Discord bot running. Press Ctrl+C to stop.')
}

async function runAPI(config: RuntimeConfig, args: string[]) {
  // Set log level from args
  if (args.includes('--quiet') || args.includes('-q')) {
    log.setLevel('error')
  } else if (args.includes('--verbose') || args.includes('-v') || args.includes('--debug') || args.includes('-d')) {
    log.setLevel('debug')
  }

  // Port/host from args override config
  const portIndex = args.indexOf('--port')
  const hostIndex = args.indexOf('--host')
  const port = portIndex !== -1 ? parseInt(args[portIndex + 1]!, 10) : (config.channels.api?.port ?? 3000)
  const host = hostIndex !== -1 ? args[hostIndex + 1]! : (config.channels.api?.host ?? '127.0.0.1')

  // Create providers
  const providers = createProviderRegistry(config)

  log.info('main', `Local provider: ${providers.local.name}`)
  if (providers.remote) {
    log.info('main', `Remote provider: ${providers.remote.name}`)
  }

  // Create memory system
  const memory = createMemory(config)

  // Create router and tools
  const router = createRouter(config)
  const toolExecutor = createDefaultToolExecutor(memory)

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

  // Create and start API server
  const api = createAPIServer({ port, host }, {
    config,
    agent,
    toolExecutor,
    memory,
    providers,
    stats,
  })

  // Handle graceful shutdown
  const shutdown = () => {
    log.info('main', 'Shutting down...')
    api.stop()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  api.start()
}

function showHelp() {
  console.log(`
egirl - Local-First AI Agent for Schneewolf Labs

Usage:
  egirl [command] [options]

Commands:
  cli            Start interactive CLI (default)
  discord        Start Discord bot
  api            Start HTTP API server
  claude-code    Bridge to Claude Code with local model supervision (alias: cc)
  status         Show current configuration and status
  help           Show this help message

Options for cli:
  -m <msg>       Send a single message and exit
  -v, --verbose  Enable verbose/debug logging
  -d, --debug    Alias for --verbose
  -q, --quiet    Only show errors

Options for discord:
  -v, --verbose  Enable verbose/debug logging
  -d, --debug    Alias for --verbose
  -q, --quiet    Only show errors

Options for api:
  --port <n>     Port to listen on (default: 3000)
  --host <addr>  Host to bind to (default: 127.0.0.1)
  -v, --verbose  Enable verbose/debug logging
  -d, --debug    Alias for --verbose
  -q, --quiet    Only show errors

Options for claude-code:
  -m <msg>       Run a single task and exit
  --resume <id>  Resume a previous Claude Code session
  -v, --verbose  Enable verbose/debug logging
  -d, --debug    Alias for --verbose
  -q, --quiet    Only show errors

Examples:
  bun run dev                          # Start with --watch
  bun run start                        # Production start
  bun run cli                          # Direct CLI mode
  bun run start discord                # Start Discord bot
  bun run start api                    # Start HTTP API on :3000
  bun run start api --port 8080        # Start HTTP API on :8080
  bun run start claude-code            # Claude Code bridge (interactive)
  bun run start cc -m "fix the tests"  # Single task mode
`)
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
