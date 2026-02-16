#!/usr/bin/env bun

import { runAPI } from './commands/api'
import { runClaudeCode } from './commands/claude-code'
import { runCLI } from './commands/cli'
import { runDiscord } from './commands/discord'
import { showStatus } from './commands/status'
import { runXMPP } from './commands/xmpp'
import { loadConfig, type RuntimeConfig } from './config'
import { BOLD, colors, DIM, RESET } from './ui/theme'
import { log } from './util/logger'
import { bootstrapWorkspace } from './workspace/bootstrap'

async function main() {
  const args = process.argv.slice(2)
  const command = args[0] ?? 'cli'

  // Load configuration
  let config: RuntimeConfig
  try {
    config = loadConfig()
    log.info('main', `Loaded config: workspace=${config.workspace.path}`)
  } catch (error) {
    log.error('main', 'Failed to load config:', error)
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
      log.error('main', `Unknown command: ${command}`)
      showHelp()
      process.exit(1)
  }
}

function showHelp() {
  const c = colors()

  console.log(`
${c.secondary}${BOLD}egirl${RESET} ${DIM}— Local-First AI Agent for Schneewolf Labs${RESET}

${c.primary}Usage${RESET}
  egirl ${DIM}[command] [options]${RESET}

${c.primary}Commands${RESET}
  ${c.accent}cli${RESET}            Start interactive CLI ${DIM}(default)${RESET}
  ${c.accent}discord${RESET}        Start Discord bot
  ${c.accent}xmpp${RESET}           Start XMPP bot
  ${c.accent}api${RESET}            Start HTTP API server
  ${c.accent}claude-code${RESET}    Bridge to Claude Code with local model supervision ${DIM}(alias: cc)${RESET}
  ${c.accent}status${RESET}         Show current configuration and status
  ${c.accent}help${RESET}           Show this help message

${c.primary}Options${RESET} ${DIM}(cli, discord, xmpp, api, claude-code)${RESET}
  ${c.accent}-v, --verbose${RESET}  Enable verbose/debug logging
  ${c.accent}-d, --debug${RESET}    Alias for --verbose
  ${c.accent}-q, --quiet${RESET}    Only show errors

${c.primary}CLI Options${RESET}
  ${c.accent}-m <msg>${RESET}       Send a single message and exit

${c.primary}API Options${RESET}
  ${c.accent}--port <n>${RESET}     Port to listen on ${DIM}(default: 3000)${RESET}
  ${c.accent}--host <addr>${RESET}  Host to bind to ${DIM}(default: 127.0.0.1)${RESET}

${c.primary}Claude Code Options${RESET}
  ${c.accent}-m <msg>${RESET}       Run a single task and exit
  ${c.accent}--resume <id>${RESET}  Resume a previous session

${c.primary}Examples${RESET}
  ${DIM}$${RESET} bun run dev                          ${DIM}# Start with --watch${RESET}
  ${DIM}$${RESET} bun run start                        ${DIM}# Production start${RESET}
  ${DIM}$${RESET} bun run start discord                ${DIM}# Start Discord bot${RESET}
  ${DIM}$${RESET} bun run start api --port 8080        ${DIM}# HTTP API on :8080${RESET}
  ${DIM}$${RESET} bun run start cc -m "fix the tests"  ${DIM}# Single task mode${RESET}
`)
}

main().catch((error) => {
  log.error('main', 'Fatal error:', error)
  process.exit(1)
})
