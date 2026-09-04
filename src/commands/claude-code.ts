import { type ClaudeCodeConfig, createClaudeCodeChannel, type TaskResult } from '../channels'
import type { RuntimeConfig } from '../config'
import { createProviderRegistry } from '../providers'
import { applyLogLevel } from '../util/args'
import { errorMessage } from '../util/errors'

/** Print a task's result and cost line, or the error and exit. */
async function report(run: () => Promise<TaskResult>): Promise<void> {
  try {
    const result = await run()
    console.log(`\n${result.result}`)
    console.log(
      `\n[${result.turns} turns | $${result.costUsd.toFixed(4)} | ${(result.durationMs / 1000).toFixed(1)}s]`,
    )
  } catch (error) {
    console.error(`Error: ${errorMessage(error)}`)
    process.exit(1)
  }
}

export async function runClaudeCode(config: RuntimeConfig, args: string[]): Promise<void> {
  applyLogLevel(args)

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

    await report(() => channel.runTask(prompt))
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
    const followUp =
      promptIdx !== -1 ? (args[promptIdx + 1] ?? 'Continue.') : 'Continue the previous task.'

    await report(() => channel.resumeSession(sessionId, followUp))
    return
  }

  // Interactive mode
  await channel.startInteractive()
}
