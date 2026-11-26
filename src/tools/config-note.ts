/**
 * A note on a file edit that changed egirl's own config.
 *
 * egirl.toml and egirl.d/*.toml are read once, at startup. An operator that raised its own
 * max_turns in its fragment kept running on the old cap and could not tell whether the edit
 * had taken. The write itself succeeds, so the result now says when it will apply.
 */

import { dirname, extname, join, resolve } from 'node:path'
import { FRAGMENT_DIR } from '../config/fragments'
import { resolveUserPath } from '../util/paths'

const FILE_TOOLS = new Set(['write_file', 'edit_file'])

/** The note to append, or undefined when the call did not touch a config file. */
export function startupConfigNote(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
  configPath: string | undefined,
): string | undefined {
  if (!configPath || !FILE_TOOLS.has(toolName) || typeof args.path !== 'string') return undefined
  const target = resolveUserPath(args.path, cwd)
  const main = resolve(configPath)
  const isMain = target === main
  const isFragment =
    dirname(target) === join(dirname(main), FRAGMENT_DIR) && extname(target) === '.toml'
  if (!isMain && !isFragment) return undefined
  return (
    '[Note: this is egirl config, read only at startup. The change takes effect after the ' +
    'instance restarts; this run keeps the settings it started with. If it needs to apply ' +
    'now, tell your principal a restart is needed.]'
  )
}
