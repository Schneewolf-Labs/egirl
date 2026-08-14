import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

/**
 * Find a real Node.js binary for the codex PTY runner.
 *
 * This project's `bunfig.toml` sets `[run] bun = true`, which aliases `node` to bun for anything
 * spawned from a `bun run` process. The PTY runner is a `.cjs` that requires `node-pty`, a native
 * N-API addon bun cannot load — so `spawn('node', [runner])` started bun, bun failed to load the
 * addon, and the process ended with status 0 having written nothing.
 *
 * The parent reads an empty transcript as "codex produced no output" and blames the working
 * directory, so every delegated task failed with a message pointing at the wrong cause. Observed
 * live: codex never ran once; the operator model silently fell through to the next provider.
 *
 * Resolution order is an explicit override, then `PATH`. Each candidate is asked whether it is
 * really node rather than trusted by name, because the name is exactly what is unreliable here.
 */

let cached: string | null | undefined

/** Ask a binary whether it is Node rather than bun. `Bun` is a global only bun defines. */
export function isRealNode(bin: string): boolean {
  try {
    const probe = spawnSync(
      bin,
      ['-e', 'process.stdout.write(typeof Bun === "undefined" ? "node" : "bun")'],
      { encoding: 'utf8', timeout: 5000 },
    )
    return probe.status === 0 && probe.stdout.trim() === 'node'
  } catch {
    return false
  }
}

export function resolveNodeBinary(
  env: NodeJS.ProcessEnv = process.env,
  probe: (bin: string) => boolean = isRealNode,
): string | undefined {
  const explicit = env.EGIRL_NODE_BIN
  if (explicit) return probe(explicit) ? explicit : undefined

  for (const dir of (env.PATH ?? '').split(':')) {
    if (!dir) continue
    const candidate = join(dir, 'node')
    if (existsSync(candidate) && probe(candidate)) return candidate
  }
  return undefined
}

/** Cached across calls — the answer cannot change within a run, and probing spawns a process. */
export function nodeBinary(): string | undefined {
  if (cached === undefined) cached = resolveNodeBinary() ?? null
  return cached ?? undefined
}

export function resetNodeBinaryCache(): void {
  cached = undefined
}

export const NODE_BINARY_MISSING =
  'Code agent unavailable: no real Node.js binary was found for the codex runner. ' +
  'The runner needs node-pty, a native module bun cannot load. Install Node.js, or set ' +
  'EGIRL_NODE_BIN to its path.'
