#!/usr/bin/env bun

import { runAPI } from './commands/api'
import { runClaudeCode } from './commands/claude-code'
import { runCLI } from './commands/cli'
import { runDiscord } from './commands/discord'
import { runServe } from './commands/serve'
import { showStatus } from './commands/status'
import { runXMPP } from './commands/xmpp'
import { loadConfig, type RuntimeConfig } from './config'
import { BOLD, colors, DIM, RESET } from './ui/theme'
import { log } from './util/logger'
import { bootstrapWorkspace } from './workspace/bootstrap'

async function main() {
  const args = process.argv.slice(2)
  const command = args[0] ?? 'cli'

  let config: RuntimeConfig
  try {
    config = loadConfig()
    log.info('main', `Loaded config: workspace=${config.workspace.path}`)
  } catch (error) {
    log.error('main', 'Failed to load config:', error)
    process.exit(1)
  }

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

    case 'serve':
      await runServe(config, args.slice(1))
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
${c.secondary}${BOLD}egirl${RESET} ${DIM}— Local AI that drives Claude Code${RESET}

${c.primary}Usage${RESET}
  egirl ${DIM}[command] [options]${RESET}

${c.primary}Commands${RESET}
  ${c.accent}cli${RESET}            Start interactive CLI ${DIM}(default)${RESET}
  ${c.accent}discord${RESET}        Start Discord bot
  ${c.accent}xmpp${RESET}           Start XMPP bot (self-hosted chat)
  ${c.accent}api${RESET}            Start HTTP API (localhost by default — scripts, automations, LAN access)
  ${c.accent}serve${RESET}          Discord + XMPP + background task runner in one process
  ${c.accent}claude-code${RESET}    Bridge to Claude Code with local model supervision ${DIM}(alias: cc)${RESET}
  ${c.accent}status${RESET}         Show current configuration and status
  ${c.accent}help${RESET}           Show this help message

${c.primary}Options${RESET} ${DIM}(all commands)${RESET}
  ${c.accent}-v, --verbose${RESET}  Enable verbose/debug logging
  ${c.accent}-d, --debug${RESET}    Alias for --verbose
  ${c.accent}-q, --quiet${RESET}    Only show errors

${c.primary}CLI / Claude Code Options${RESET}
  ${c.accent}-m <msg>${RESET}       Send a single message / run a single task and exit
  ${c.accent}--resume <id>${RESET}  Resume a previous Claude Code session

${c.primary}Examples${RESET}
  ${DIM}$${RESET} bun run cli                            ${DIM}# Interactive chat${RESET}
  ${DIM}$${RESET} bun run start discord                  ${DIM}# Discord bot${RESET}
  ${DIM}$${RESET} bun run start serve                    ${DIM}# Discord + scheduler${RESET}
  ${DIM}$${RESET} bun run start cc -m "fix the tests"    ${DIM}# Delegate directly to Claude Code${RESET}
`)
}

main().catch((error) => {
  log.error('main', 'Fatal error:', error)
  process.exit(1)
})
