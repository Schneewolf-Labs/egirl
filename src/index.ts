#!/usr/bin/env bun

import { runAPI } from './commands/api'
import { runClaudeCode } from './commands/claude-code'
import { runCLI } from './commands/cli'
import { runDiscord } from './commands/discord'
import { runDoctor } from './commands/doctor'
import { runInit } from './commands/init'
import { runMatrix } from './commands/matrix'
import { runNew } from './commands/new'
import { runServe } from './commands/serve'
import { showStatus } from './commands/status'
import { runTelegram } from './commands/telegram'
import { runXMPP } from './commands/xmpp'
import { findConfigFile, loadConfig, type RuntimeConfig } from './config'
import { loadInstanceEnv } from './config/env-files'
import { BOLD, colors, DIM, RESET } from './ui/theme'
import { log } from './util/logger'
import { bootstrapWorkspace } from './workspace/bootstrap'

interface ParsedArgs {
  command: string
  commandArgs: string[]
  instance?: string
}

function parseGlobalArgs(args: string[]): ParsedArgs {
  const remaining: string[] = []
  let instance: string | undefined

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue

    if (arg === '--instance') {
      const value = args[++i]
      if (!value) throw new Error('--instance requires a name')
      instance = value
      continue
    }

    remaining.push(arg)
  }

  return {
    command: remaining[0] ?? 'cli',
    commandArgs: remaining.slice(1),
    ...(instance && { instance }),
  }
}

async function main() {
  const parsed = parseGlobalArgs(process.argv.slice(2))
  const { command, commandArgs, instance } = parsed

  if (command === 'init') {
    await runInit(commandArgs)
    return
  }

  // Runs before loadConfig on purpose: `new` edits the config that loadConfig would read, and
  // the instance it creates does not exist yet, so resolving one here would always fail.
  //
  // Caught here rather than left to the top-level handler, which hands the Error to the logger
  // and prints `{}` -- every failure this command has is a message the user needs to read
  // ("unknown profile", "instance already exists").
  if (command === 'new') {
    try {
      await runNew(commandArgs)
    } catch (error) {
      const c = colors()
      console.error(
        `${c.error}error${RESET} ${error instanceof Error ? error.message : String(error)}`,
      )
      process.exit(1)
    }
    return
  }

  if (command === 'help' || command === '--help' || command === '-h') {
    showHelp()
    return
  }

  // Before loadConfig, because config expands $VAR from process.env: an instance whose Wald
  // token lives in .env.<instance> would otherwise resolve the shared one from .env.
  const instanceEnv = loadInstanceEnv(instance, findConfigFile() ?? undefined)
  if (instanceEnv) {
    log.info('main', `Loaded ${instanceEnv.path} (${instanceEnv.keys.length} var(s))`)
  }

  let config: RuntimeConfig
  try {
    config = loadConfig({ instance })
    const instanceLabel = config.source.instance ? ` instance=${config.source.instance}` : ''
    log.info('main', `Loaded config: workspace=${config.workspace.path}${instanceLabel}`)
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
      await runCLI(config, commandArgs)
      break

    case 'status':
      await showStatus(config)
      break

    case 'doctor':
      await runDoctor(config)
      break

    case 'claude-code':
    case 'cc':
      await runClaudeCode(config, commandArgs)
      break

    case 'discord':
      await runDiscord(config, commandArgs)
      break

    case 'xmpp':
      await runXMPP(config, commandArgs)
      break

    case 'telegram':
      await runTelegram(config, commandArgs)
      break

    case 'matrix':
      await runMatrix(config, commandArgs)
      break

    case 'api':
      await runAPI(config, commandArgs)
      break

    case 'serve':
      await runServe(config, commandArgs)
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
${c.secondary}${BOLD}egirl${RESET} ${DIM}— Local AI that drives code agents${RESET}

${c.primary}Usage${RESET}
  egirl ${DIM}[command] [options]${RESET}

${c.primary}Commands${RESET}
  ${c.accent}cli${RESET}            Start interactive CLI ${DIM}(default)${RESET}
  ${c.accent}init${RESET}           Create starter egirl.toml and .env files
  ${c.accent}new${RESET}            Scaffold a new instance: persona files, config block, free API port
  ${c.accent}doctor${RESET}         Check local model, config, and code-agent setup
  ${c.accent}discord${RESET}        Start Discord bot
  ${c.accent}xmpp${RESET}           Start XMPP bot (self-hosted chat)
  ${c.accent}telegram${RESET}       Start Telegram bot
  ${c.accent}matrix${RESET}         Start Matrix bot (unencrypted rooms)
  ${c.accent}api${RESET}            Start HTTP API (localhost by default — scripts, automations, LAN access)
  ${c.accent}serve${RESET}          Discord + XMPP + Telegram + Matrix + background task runner in one process
  ${c.accent}claude-code${RESET}    Bridge to Claude Code with local model supervision ${DIM}(alias: cc)${RESET}
  ${c.accent}status${RESET}         Show current configuration and status
  ${c.accent}help${RESET}           Show this help message

${c.primary}Options${RESET} ${DIM}(all commands)${RESET}
  ${c.accent}-v, --verbose${RESET}  Enable verbose/debug logging
  ${c.accent}-d, --debug${RESET}    Alias for --verbose
  ${c.accent}-q, --quiet${RESET}    Only show errors
  ${c.accent}--instance <name>${RESET} Select a named instance from egirl.toml

${c.primary}CLI / Code Agent Options${RESET}
  ${c.accent}-m <msg>${RESET}       Send a single message / run a single task and exit
  ${c.accent}--resume <id>${RESET}  Resume a previous Claude Code session

${c.primary}Examples${RESET}
  ${DIM}$${RESET} bun run start init --provider codex       ${DIM}# Write starter config${RESET}
  ${DIM}$${RESET} bun run start doctor                      ${DIM}# Check setup${RESET}
  ${DIM}$${RESET} bun run start new zero --profile big-box  ${DIM}# Scaffold an instance${RESET}
  ${DIM}$${RESET} bun run start --instance ops-big cli       ${DIM}# Run a named instance${RESET}
  ${DIM}$${RESET} bun run cli                              ${DIM}# Interactive chat${RESET}
  ${DIM}$${RESET} bun run start discord                    ${DIM}# Discord bot${RESET}
  ${DIM}$${RESET} bun run start serve                      ${DIM}# Discord + scheduler${RESET}
  ${DIM}$${RESET} bun run start cc -m "fix the tests"      ${DIM}# Direct Claude Code bridge${RESET}
`)
}

main().catch((error) => {
  log.error('main', 'Fatal error:', error)
  process.exit(1)
})
