import { accessSync, constants } from 'fs'
import { delimiter, join } from 'path'
import type { RuntimeConfig } from '../config'
import { type CheckResult, runPreflight } from '../instances/preflight'
import { colors, DIM, RESET } from '../ui/theme'
import { errorMessage } from '../util/errors'

function commandExists(command: string): boolean {
  const paths = process.env.PATH?.split(delimiter) ?? []

  for (const dir of paths) {
    try {
      accessSync(join(dir, command), constants.X_OK)
      return true
    } catch {
      // Try next PATH entry.
    }
  }

  return false
}

function endpointUsesBindAddress(endpoint: string): boolean {
  try {
    const url = new URL(endpoint)
    return url.hostname === '0.0.0.0'
  } catch {
    return false
  }
}

async function checkLocalEndpoint(config: RuntimeConfig): Promise<CheckResult> {
  try {
    const url = new URL('/v1/models', config.local.endpoint)
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!response.ok) {
      return {
        label: 'local model',
        level: 'fail',
        message: `${config.local.endpoint} returned HTTP ${response.status}`,
      }
    }
    return { label: 'local model', level: 'ok', message: `${config.local.endpoint} is reachable` }
  } catch (error) {
    const message = errorMessage(error)
    return { label: 'local model', level: 'fail', message }
  }
}

function printResult(result: CheckResult): void {
  const c = colors()
  const status =
    result.level === 'ok'
      ? `${c.success}ok${RESET}`
      : result.level === 'warn'
        ? `${c.warning}warn${RESET}`
        : `${c.error}fail${RESET}`
  console.log(`  ${status} ${DIM}${result.label}${RESET} ${result.message}`)
}

export async function runDoctor(config: RuntimeConfig): Promise<void> {
  const c = colors()
  const results: CheckResult[] = []

  console.log(`\n${c.secondary}egirl${RESET} ${DIM}Doctor${RESET}\n`)

  results.push({
    label: 'config',
    level: 'ok',
    message:
      config.source.path ??
      'using built-in defaults; run `bun run start init` to create egirl.toml',
  })

  if (config.source.instance || config.source.profile || config.source.persona) {
    results.push({
      label: 'instance',
      level: 'ok',
      message: `${config.source.instance ?? 'default'} (profile=${config.source.profile ?? 'top-level'}, persona=${config.source.persona ?? 'top-level'})`,
    })
  }

  if (endpointUsesBindAddress(config.local.endpoint)) {
    results.push({
      label: 'endpoint',
      level: 'fail',
      message: `${config.local.endpoint} uses 0.0.0.0; clients should use localhost or a LAN IP`,
    })
  } else {
    results.push({
      label: 'endpoint',
      level: 'ok',
      message: config.local.endpoint,
    })
  }

  results.push(await checkLocalEndpoint(config))

  if (!config.tools.codeAgent) {
    results.push({
      label: 'code agent tool',
      level: 'fail',
      message: 'disabled; set [tools] code_agent = true',
    })
  } else {
    results.push({ label: 'code agent tool', level: 'ok', message: 'enabled' })
  }

  if (!config.channels.codeAgent) {
    results.push({
      label: 'code agent config',
      level: 'fail',
      message: 'missing [channels.code_agent]',
    })
  } else {
    const provider = config.channels.codeAgent.provider ?? 'claude'
    const binary = provider === 'codex' ? 'codex' : provider === 'opencode' ? 'opencode' : 'claude'
    const binaryFound = commandExists(binary)
    results.push({
      label: 'code agent config',
      level: 'ok',
      message: `${provider}, permission_mode=${config.channels.codeAgent.permissionMode}`,
    })
    results.push({
      label: `${binary} cli`,
      level: binaryFound ? 'ok' : 'fail',
      message: binaryFound ? `${binary} found on PATH` : `${binary} not found on PATH`,
    })
  }

  results.push({
    label: 'permissions',
    level: 'ok',
    message: `${config.permissionSupervisor.mode}, default=${config.permissionSupervisor.defaultAction}`,
  })

  if (config.source.codeAgentUsesClaudeCodeFallback) {
    results.push({
      label: 'migration',
      level: 'fail',
      message:
        '[channels.claude_code] is being used as code_agent fallback; add [channels.code_agent]',
    })
  }

  // The rest of the dependency graph: auxiliary, embeddings, MCP, API port, and what the
  // operator endpoint is really serving. Skipped when the endpoint is already down, since every
  // one of these would just restate the same failure.
  const endpointUp = results.some(
    (result) => result.label === 'local model' && result.level === 'ok',
  )
  if (endpointUp) {
    results.push(...(await runPreflight(config)))
  }

  for (const result of results) printResult(result)

  const failed = results.filter((result) => result.level === 'fail')
  const warned = results.filter((result) => result.level === 'warn')
  if (failed.length > 0) {
    const suffix = warned.length > 0 ? `, ${warned.length} warning(s)` : ''
    console.log(`\n${c.error}${failed.length} issue(s) found${RESET}${suffix}`)
    process.exitCode = 1
  } else if (warned.length > 0) {
    console.log(`\n${c.warning}usable, ${warned.length} warning(s)${RESET}`)
  } else {
    console.log(`\n${c.success}setup looks usable${RESET}`)
  }
}
