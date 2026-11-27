import type { RuntimeConfig } from '../config'
import { type CheckResult, runPreflight } from '../instances/preflight'
import { colors, DIM, RESET } from '../ui/theme'
import { errorMessage } from '../util/errors'

function commandExists(command: string): boolean {
  return Bun.which(command) !== null
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
  if (config.local.isClaude) {
    return {
      label: 'local model',
      level: 'ok',
      message: `side work on Claude (${config.local.model})`,
    }
  }
  try {
    const url = new URL('/v1/models', config.local.endpoint)
    const response = await fetch(url, {
      headers: config.local.apiKey ? { Authorization: `Bearer ${config.local.apiKey}` } : {},
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) {
      return {
        label: 'local model',
        level: 'fail',
        message: `${config.local.endpoint} returned HTTP ${response.status}`,
      }
    }
    return { label: 'local model', level: 'ok', message: `${config.local.endpoint} is reachable` }
  } catch (error) {
    return {
      label: 'local model',
      level: 'fail',
      message: `${config.local.endpoint}: ${errorMessage(error)}`,
    }
  }
}

function printResult(result: CheckResult): void {
  const c = colors()
  const status =
    result.level === 'ok'
      ? `${c.success}ok${RESET}`
      : result.level === 'warn'
        ? `${c.warning}warn${RESET}`
        : result.level === 'skip'
          ? `${c.muted}skip${RESET}`
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
    // Only the URL's shape is checked here; whether anything answers there is the next line.
    results.push({
      label: 'endpoint',
      level: 'ok',
      message: `configured: ${config.local.endpoint}`,
    })
  }

  results.push(await checkLocalEndpoint(config))

  // The code agent is optional: off is a skip, not a failure. Only a half-done setup warns.
  if (!config.tools.codeAgent) {
    results.push({
      label: 'code agent tool',
      level: config.channels.codeAgent ? 'warn' : 'skip',
      message: config.channels.codeAgent
        ? '[channels.code_agent] is configured but [tools] code_agent is off'
        : 'off (optional: docs/optional-services.md#code-agent)',
    })
  } else {
    results.push({ label: 'code agent tool', level: 'ok', message: 'enabled' })
  }

  if (!config.channels.codeAgent) {
    if (config.tools.codeAgent) {
      results.push({
        label: 'code agent config',
        level: 'warn',
        message: 'missing [channels.code_agent]; the tool is not registered until one is set',
      })
    }
  } else {
    const provider = config.channels.codeAgent.provider ?? 'claude'
    const binary =
      provider === 'acp'
        ? (config.channels.codeAgent.acpCommand?.[0] ?? 'acp_command')
        : provider === 'codex'
          ? 'codex'
          : provider === 'opencode'
            ? 'opencode'
            : 'claude'
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
  // operator endpoint is really serving. Each is its own service and is probed regardless; only
  // the served-model check depends on the operator endpoint, and it reports itself skipped.
  const isOperatorUp = results.some(
    (result) => result.label === 'local model' && result.level === 'ok',
  )
  results.push(...(await runPreflight(config, { isOperatorUp })))

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
