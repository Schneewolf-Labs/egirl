import { accessSync, constants } from 'fs'
import { delimiter, join } from 'path'
import type { RuntimeConfig } from '../config'
import { colors, DIM, RESET } from '../ui/theme'

interface CheckResult {
  label: string
  ok: boolean
  message: string
}

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
        ok: false,
        message: `${config.local.endpoint} returned HTTP ${response.status}`,
      }
    }
    return { label: 'local model', ok: true, message: `${config.local.endpoint} is reachable` }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { label: 'local model', ok: false, message }
  }
}

function printResult(result: CheckResult): void {
  const c = colors()
  const status = result.ok ? `${c.success}ok${RESET}` : `${c.error}fail${RESET}`
  console.log(`  ${status} ${DIM}${result.label}${RESET} ${result.message}`)
}

export async function runDoctor(config: RuntimeConfig): Promise<void> {
  const c = colors()
  const results: CheckResult[] = []

  console.log(`\n${c.secondary}egirl${RESET} ${DIM}Doctor${RESET}\n`)

  results.push({
    label: 'config',
    ok: true,
    message:
      config.source.path ??
      'using built-in defaults; run `bun run start init` to create egirl.toml',
  })

  if (config.source.instance || config.source.profile || config.source.persona) {
    results.push({
      label: 'instance',
      ok: true,
      message: `${config.source.instance ?? 'default'} (profile=${config.source.profile ?? 'top-level'}, persona=${config.source.persona ?? 'top-level'})`,
    })
  }

  if (endpointUsesBindAddress(config.local.endpoint)) {
    results.push({
      label: 'endpoint',
      ok: false,
      message: `${config.local.endpoint} uses 0.0.0.0; clients should use localhost or a LAN IP`,
    })
  } else {
    results.push({
      label: 'endpoint',
      ok: true,
      message: config.local.endpoint,
    })
  }

  results.push(await checkLocalEndpoint(config))

  if (!config.tools.codeAgent) {
    results.push({
      label: 'code agent tool',
      ok: false,
      message: 'disabled; set [tools] code_agent = true',
    })
  } else {
    results.push({ label: 'code agent tool', ok: true, message: 'enabled' })
  }

  if (!config.channels.codeAgent) {
    results.push({
      label: 'code agent config',
      ok: false,
      message: 'missing [channels.code_agent]',
    })
  } else {
    const provider = config.channels.codeAgent.provider ?? 'claude'
    const binary = provider === 'codex' ? 'codex' : provider === 'opencode' ? 'opencode' : 'claude'
    const binaryFound = commandExists(binary)
    results.push({
      label: 'code agent config',
      ok: true,
      message: `${provider}, permission_mode=${config.channels.codeAgent.permissionMode}`,
    })
    results.push({
      label: `${binary} cli`,
      ok: binaryFound,
      message: binaryFound ? `${binary} found on PATH` : `${binary} not found on PATH`,
    })
  }

  results.push({
    label: 'permissions',
    ok: true,
    message: `${config.permissionSupervisor.mode}, default=${config.permissionSupervisor.defaultAction}`,
  })

  if (config.source.codeAgentUsesClaudeCodeFallback) {
    results.push({
      label: 'migration',
      ok: false,
      message:
        '[channels.claude_code] is being used as code_agent fallback; add [channels.code_agent]',
    })
  }

  for (const result of results) printResult(result)

  const failed = results.filter((result) => !result.ok)
  if (failed.length > 0) {
    console.log(`\n${c.warning}${failed.length} issue(s) found${RESET}`)
    process.exitCode = 1
  } else {
    console.log(`\n${c.success}setup looks usable${RESET}`)
  }
}
