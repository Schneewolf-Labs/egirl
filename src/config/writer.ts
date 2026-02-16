import { existsSync } from 'fs'
import { homedir } from 'os'
import { resolve } from 'path'
import { log } from '../util/logger'

function findConfigPath(): string {
  const candidates = [
    resolve(process.cwd(), 'egirl.toml'),
    resolve(homedir(), '.egirl', 'egirl.toml'),
    resolve(homedir(), '.config', 'egirl', 'egirl.toml'),
  ]

  for (const path of candidates) {
    if (existsSync(path)) return path
  }

  // Default to cwd if no existing config found
  return resolve(process.cwd(), 'egirl.toml')
}

function tomlValue(val: unknown): string {
  if (typeof val === 'string') return JSON.stringify(val)
  if (typeof val === 'boolean') return val ? 'true' : 'false'
  if (typeof val === 'number') return String(val)
  if (Array.isArray(val)) {
    return `[${val.map((v) => tomlValue(v)).join(', ')}]`
  }
  return String(val)
}

function serializeToml(obj: Record<string, unknown>, prefix = ''): string {
  const lines: string[] = []
  const tables: Array<[string, Record<string, unknown>]> = []

  for (const [key, val] of Object.entries(obj)) {
    if (val === undefined || val === null) continue

    if (typeof val === 'object' && !Array.isArray(val)) {
      tables.push([key, val as Record<string, unknown>])
    } else {
      lines.push(`${key} = ${tomlValue(val)}`)
    }
  }

  for (const [key, val] of tables) {
    const section = prefix ? `${prefix}.${key}` : key
    lines.push('')
    lines.push(`[${section}]`)

    // Separate primitives from nested objects
    const nested: Array<[string, Record<string, unknown>]> = []

    for (const [k, v] of Object.entries(val)) {
      if (v === undefined || v === null) continue

      if (typeof v === 'object' && !Array.isArray(v)) {
        nested.push([k, v as Record<string, unknown>])
      } else {
        lines.push(`${k} = ${tomlValue(v)}`)
      }
    }

    for (const [k, v] of nested) {
      const nestedSection = `${section}.${k}`
      lines.push('')
      lines.push(`[${nestedSection}]`)
      for (const [nk, nv] of Object.entries(v)) {
        if (nv === undefined || nv === null) continue
        if (typeof nv === 'object' && !Array.isArray(nv)) continue // skip deep nesting
        lines.push(`${nk} = ${tomlValue(nv)}`)
      }
    }
  }

  return `${lines.join('\n')}\n`
}

export async function writeConfigToml(config: Record<string, unknown>): Promise<void> {
  const path = findConfigPath()
  const toml = serializeToml(config)
  await Bun.write(path, toml)
  log.info('config', `Configuration written to ${path}`)
}
