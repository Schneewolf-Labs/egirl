#!/usr/bin/env bun

import { loadConfig, type RuntimeConfig } from './config'
import { bootstrapWorkspace } from './workspace/bootstrap'
import { log } from './util/logger'

import { runCLI } from './commands/cli'
import { runDiscord } from './commands/discord'
import { runXMPP } from './commands/xmpp'
import { runClaudeCode } from './commands/claude-code'
import { runAPI } from './commands/api'
import { showStatus } from './commands/status'

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

    case 'xmpp':
      await runXMPP(config, args.slice(1))
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

function showHelp() {
  console.log(`
egirl - Local-First AI Agent for Schneewolf Labs

Usage:
  egirl [command] [options]

Commands:
  cli            Start interactive CLI (default)
  discord        Start Discord bot
  xmpp           Start XMPP bot
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

Options for xmpp:
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
  bun run start xmpp                   # Start XMPP bot
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
