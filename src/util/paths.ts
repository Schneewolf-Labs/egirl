import { homedir } from 'node:os'
import { resolve } from 'node:path'

/**
 * Resolve a path a tool was handed. `~` and `~/…` mean the user's home, as they would in a shell:
 * models write them constantly, and resolved against the workspace they became a directory named
 * `~` inside it. Anything else relative is against `cwd`. File tools and the path guard must both
 * go through here, or the guard checks one path while the tool touches another.
 */
export function resolveUserPath(path: string, cwd: string, home: string = homedir()): string {
  if (path === '~') return resolve(home)
  if (path.startsWith('~/') || path.startsWith('~\\')) return resolve(home, path.slice(2))
  // resolve() rather than passing absolute paths through: it is what callers did before, and on
  // Windows it gives "/tmp/x" its drive, so the guard compares like with like.
  return resolve(cwd, path)
}
