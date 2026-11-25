/**
 * `egirl install`: put an `egirl` command on PATH that runs this checkout from anywhere.
 *
 * Running from the repo was the only way that worked: the config is found in the current
 * directory, and Bun loads `.env` from it too. Launched from another directory, egirl found no
 * egirl.toml and none of the secrets. The launcher pins both to this checkout -- unless the
 * directory it is run in has its own egirl.toml, which then wins as it always has -- and keeps
 * the caller's working directory, because that is where file tools and the code agent work.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { colors, DIM, RESET } from '../ui/theme'

/** Marks a launcher as ours, so re-running install replaces it but never someone else's file. */
const MARKER = '# egirl launcher (written by `egirl install`)'

/** The checkout this command is part of: src/commands/install.ts -> repo root. */
const REPO_DIR = resolve(import.meta.dir, '..', '..')

export interface InstallOptions {
  binDir: string
  force: boolean
}

export function parseInstallArgs(args: string[]): InstallOptions {
  const at = args.indexOf('--bin-dir')
  const binDir = at !== -1 ? args[at + 1] : undefined
  if (at !== -1 && !binDir) throw new Error('--bin-dir requires a directory')
  return {
    binDir: resolve(binDir ?? join(homedir(), '.local', 'bin')),
    force: args.includes('--force'),
  }
}

/** The launcher script for a checkout at `repoDir`. */
export function launcherScript(repoDir: string): string {
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
  return `#!/bin/sh
${MARKER}
# Runs the egirl checkout at ${repoDir}. Re-run \`egirl install\` if the checkout moves.
REPO=${q(repoDir)}
# A directory with its own egirl.toml keeps using it; anywhere else, this checkout's config.
if [ -z "$EGIRL_CONFIG" ] && [ ! -f egirl.toml ] && [ -f "$REPO/egirl.toml" ]; then
  EGIRL_CONFIG="$REPO/egirl.toml"
  export EGIRL_CONFIG
fi
# Bun loads .env from the working directory; the checkout's secrets live beside its config.
if [ ! -f .env ] && [ -f "$REPO/.env" ]; then
  exec bun --env-file="$REPO/.env" "$REPO/src/index.ts" "$@"
fi
exec bun "$REPO/src/index.ts" "$@"
`
}

/** Write the launcher. Returns the lines to print. */
export function install(
  opts: InstallOptions,
  repoDir = REPO_DIR,
  path = process.env.PATH ?? '',
): string[] {
  const c = colors()
  const target = join(opts.binDir, 'egirl')
  if (existsSync(target) && !opts.force && !readFileSync(target, 'utf-8').includes(MARKER)) {
    throw new Error(`${target} exists and was not written by egirl install (use --force)`)
  }
  mkdirSync(opts.binDir, { recursive: true })
  writeFileSync(target, launcherScript(repoDir))
  chmodSync(target, 0o755)

  const lines = [`${c.success}installed${RESET} ${target} ${DIM}→ ${repoDir}${RESET}`]
  if (!path.split(delimiter).includes(opts.binDir)) {
    lines.push(
      `${c.warning}${opts.binDir} is not on PATH${RESET} ${DIM}— add it to your shell profile:${RESET}`,
      `  export PATH="${opts.binDir}:$PATH"`,
    )
  }
  lines.push(
    `${DIM}then, from any directory:${RESET} egirl cli ${DIM}· egirl cli <instance>${RESET}`,
  )
  return lines
}
