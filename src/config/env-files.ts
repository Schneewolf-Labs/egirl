import { existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'

/**
 * Per-instance secrets: `.env.<instance>` beside `.env`.
 *
 * One `.env` means every instance shares one identity. Two operators pointing at the same Wald
 * present the same bearer token, so the registry cannot tell them apart and neither can its audit
 * log -- and an instance that should only reach a scoped set of services gets the full set
 * because that is all there is.
 *
 * Precedence is most-specific-wins: `.env.<instance>` overrides `.env`. That has to include
 * variables already in `process.env`, because Bun loads `.env` into the environment before any of
 * this runs -- leaving those alone would mean the instance file silently did nothing for exactly
 * the keys it was written to override. The cost is that a variable exported in the shell also
 * loses to the instance file.
 */

export interface LoadedEnvFile {
  path: string
  keys: string[]
}

/**
 * Minimal KEY=VALUE parsing: comments, blank lines, `export` prefixes, and quoted values.
 *
 * Deliberately not a full dotenv implementation -- no interpolation, no multi-line values. The
 * file holds tokens, and a parser that silently reinterprets a token containing `$` or `#` is
 * worse than one that does not try.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {}

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line
    const equals = withoutExport.indexOf('=')
    if (equals <= 0) continue

    const key = withoutExport.slice(0, equals).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue

    let value = withoutExport.slice(equals + 1).trim()
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1)
    } else {
      // Unquoted values take a trailing comment; a quoted one is taken literally.
      const comment = value.indexOf(' #')
      if (comment >= 0) value = value.slice(0, comment).trim()
    }

    values[key] = value
  }

  return values
}

/**
 * Apply `.env.<instance>` on top of the already-loaded environment.
 *
 * Returns what it loaded so the caller can report it: a secrets file that was silently not found
 * looks identical to one that was found and empty, and the two need very different fixes.
 */
export function loadInstanceEnv(
  instance: string | undefined,
  configPath?: string,
): LoadedEnvFile | undefined {
  if (!instance) return undefined

  const dir = configPath ? dirname(configPath) : process.cwd()
  const path = join(dir, `.env.${instance}`)
  if (!existsSync(path)) return undefined

  const values = parseEnvFile(readFileSync(path, 'utf-8'))
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value
  }

  return { path, keys: Object.keys(values) }
}
