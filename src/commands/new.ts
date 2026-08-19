import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { parse } from 'smol-toml'
import { findConfigFile } from '../config'
import {
  collectConfiguredPorts,
  findFreePort,
  instanceNames,
  isValidName,
  profileNames,
  renderInstanceToml,
  renderPersonaFiles,
  type ScaffoldOptions,
} from '../instances/scaffold'
import { colors, DIM, RESET } from '../ui/theme'

interface NewOptions {
  name: string
  theme: string
  profile?: string
  endpoint?: string
  model?: string
  port?: number
}

function parseOptions(args: string[]): NewOptions {
  const name = args[0]
  if (!name || name.startsWith('-')) {
    throw new Error('Usage: egirl new <name> [--profile <p> | --endpoint <url> --model <m>]')
  }

  const options: NewOptions = { name, theme: 'egirl' }

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    const next = (): string => {
      const value = args[++i]
      if (!value) throw new Error(`${arg} requires a value`)
      return value
    }

    if (arg === '--theme') {
      options.theme = next()
      continue
    }
    if (arg === '--profile') {
      options.profile = next()
      continue
    }
    if (arg === '--endpoint') {
      options.endpoint = next()
      continue
    }
    if (arg === '--model') {
      options.model = next()
      continue
    }
    if (arg === '--port') {
      const value = Number(next())
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        throw new Error('--port must be a port number')
      }
      options.port = value
      continue
    }
    throw new Error(`Unknown new option: ${arg}`)
  }

  return options
}

function expandHome(path: string): string {
  return path.replace(/^~/, homedir())
}

/**
 * Where the loader will look for this persona's workspace.
 *
 * Must match `resolveTomlConfig` exactly: it derives the path from `[defaults] workspace_root`
 * and falls back to ~/.egirl. Scaffolding to any other directory produces files the agent never
 * reads, and a persona that silently runs on the bootstrapped defaults instead.
 */
function personaWorkspace(toml: unknown, name: string): string {
  const defaults =
    typeof toml === 'object' && toml !== null
      ? (toml as Record<string, unknown>).defaults
      : undefined
  const root =
    typeof defaults === 'object' && defaults !== null
      ? (defaults as Record<string, unknown>).workspace_root
      : undefined

  return join(expandHome(typeof root === 'string' ? root : '~/.egirl'), 'personas', name)
}

export async function runNew(args: string[]): Promise<void> {
  const c = colors()
  const options = parseOptions(args)

  if (!isValidName(options.name)) {
    throw new Error(
      `Invalid name "${options.name}": use lowercase letters, digits, dashes and underscores`,
    )
  }

  const configPath = findConfigFile()
  if (!configPath) {
    throw new Error('No egirl.toml found. Run `bun run start init` first.')
  }

  const toml = parse(readFileSync(configPath, 'utf-8')) as unknown

  if (instanceNames(toml).includes(options.name)) {
    throw new Error(`Instance "${options.name}" already exists in ${configPath}`)
  }

  // Either reuse a profile that exists, or define one from an endpoint. Naming a profile that is
  // not there fails at load time with a less obvious message than this one.
  const profiles = profileNames(toml)
  if (options.profile && !profiles.includes(options.profile)) {
    throw new Error(
      `Unknown profile "${options.profile}". Defined: ${profiles.join(', ') || '(none)'}`,
    )
  }
  if (!options.profile && !options.endpoint) {
    throw new Error(
      `Need --profile <name> to reuse a profile, or --endpoint <url> to define one. ` +
        `Defined profiles: ${profiles.join(', ') || '(none)'}`,
    )
  }

  const port = options.port ?? (await findFreePort(collectConfiguredPorts(toml)))

  const workspace = personaWorkspace(toml, options.name)
  if (existsSync(workspace)) {
    throw new Error(`Workspace ${workspace} already exists`)
  }

  const scaffold: ScaffoldOptions = {
    name: options.name,
    theme: options.theme,
    port,
    ...(options.profile && { profile: options.profile }),
    ...(options.endpoint && { endpoint: options.endpoint }),
    ...(options.model && { model: options.model }),
  }

  mkdirSync(workspace, { recursive: true })
  for (const [filename, content] of Object.entries(renderPersonaFiles(options.name))) {
    writeFileSync(join(workspace, filename), content)
    console.log(`${c.success}write${RESET} ${join(workspace, filename)}`)
  }

  appendFileSync(configPath, renderInstanceToml(scaffold))
  console.log(`${c.success}write${RESET} ${configPath} ${DIM}(instance ${options.name})${RESET}`)

  console.log(`\n${c.primary}Instance${RESET} ${options.name}`)
  console.log(`  ${DIM}profile${RESET}   ${options.profile ?? options.name}`)
  console.log(`  ${DIM}workspace${RESET} ${workspace}`)
  console.log(`  ${DIM}api port${RESET}  ${port}`)

  console.log(`\n${c.primary}Next${RESET}`)
  console.log(`  ${DIM}# describe the personality before first run${RESET}`)
  console.log(`  $EDITOR ${join(workspace, 'SOUL.md')}`)
  console.log(`  bun run start --instance ${options.name} doctor`)
  console.log(`  bun run start --instance ${options.name} cli`)
}
