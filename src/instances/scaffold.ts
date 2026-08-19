import { createServer } from 'net'

/**
 * Rendering and collision-avoidance for a new instance.
 *
 * Kept apart from the command so the parts that can be wrong quietly -- port selection and TOML
 * rendering -- are testable without touching a filesystem or a live config.
 */

export interface ScaffoldOptions {
  name: string
  theme: string
  /** Reuse an existing profile by name, or create one when endpoint/model are given. */
  profile?: string
  endpoint?: string
  model?: string
  port: number
}

const DEFAULT_PORT_BASE = 3000

/**
 * Every API port the config already spells out, wherever it is declared.
 *
 * Ports live in three places -- the top-level `[channels.api]`, one per profile, and one per
 * instance override -- and a scan that misses any of them hands out a port that is already
 * spoken for. The collision does not surface until both instances run at once, which is not
 * when you want to find out.
 */
export function collectConfiguredPorts(toml: unknown): number[] {
  const ports: number[] = []

  const portOf = (value: unknown): number | undefined => {
    if (!isRecord(value)) return undefined
    const channels = value.channels
    if (!isRecord(channels)) return undefined
    const api = channels.api
    if (!isRecord(api)) return undefined
    return typeof api.port === 'number' ? api.port : undefined
  }

  if (!isRecord(toml)) return ports

  const top = portOf(toml)
  if (top !== undefined) ports.push(top)

  for (const group of ['profiles', 'instances']) {
    const collection = toml[group]
    if (!isRecord(collection)) continue
    for (const entry of Object.values(collection)) {
      const port = portOf(entry)
      if (port !== undefined) ports.push(port)
    }
  }

  return ports
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True when nothing is listening and we can bind it ourselves. */
export async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

/**
 * First port that is neither claimed in config nor currently bound.
 *
 * Both halves are load-bearing. Config alone misses a port held by something that is not egirl;
 * a bind probe alone misses a sibling instance that is configured but not running right now, and
 * would happily hand out its port.
 */
export async function findFreePort(
  taken: Iterable<number>,
  base: number = DEFAULT_PORT_BASE,
): Promise<number> {
  const claimed = new Set(taken)
  for (let port = base; port < base + 200; port++) {
    if (claimed.has(port)) continue
    if (await isPortFree(port)) return port
  }
  throw new Error(`No free API port in ${base}-${base + 199}`)
}

export function instanceNames(toml: unknown): string[] {
  if (!isRecord(toml)) return []
  const instances = toml.instances
  return isRecord(instances) ? Object.keys(instances) : []
}

export function profileNames(toml: unknown): string[] {
  if (!isRecord(toml)) return []
  const profiles = toml.profiles
  return isRecord(profiles) ? Object.keys(profiles) : []
}

/** Instance names are TOML bare keys and directory names; keep them boring. */
export function isValidName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/.test(name)
}

export function renderInstanceToml(options: ScaffoldOptions): string {
  const { name, theme, profile, endpoint, model, port } = options
  const lines: string[] = ['']

  if (endpoint) {
    lines.push(
      `[profiles.${name}.local]`,
      `endpoint = "${endpoint}"`,
      `model = "${model ?? 'set-me'}"`,
      'context_length = 32768',
      'max_concurrent = 2',
      '',
      `[profiles.${name}.channels.code_agent]`,
      'provider = "codex"',
      'permission_mode = "default"',
      '',
      `[profiles.${name}.channels.api]`,
      'host = "127.0.0.1"',
      `port = ${port}`,
      '',
    )
  }

  lines.push(`[personas.${name}]`, `theme = "${theme}"`, '', `[instances.${name}]`)
  lines.push(`profile = "${profile ?? name}"`)
  lines.push(`persona = "${name}"`)

  // An instance reusing someone else's profile still needs its own port, or both instances bind
  // the same one and the second to start dies.
  if (!endpoint) {
    lines.push('', `[instances.${name}.channels.api]`, 'host = "127.0.0.1"', `port = ${port}`)
  }

  lines.push('')
  return lines.join('\n')
}

/**
 * Starter personality files for a new persona.
 *
 * Deliberately neutral rather than a copy of the default persona: a new instance exists because
 * the user wants a different temperament, and inheriting one wholesale means editing someone
 * else's voice out before writing their own.
 */
export function renderPersonaFiles(name: string): Record<string, string> {
  const title = name.charAt(0).toUpperCase() + name.slice(1)

  return {
    'IDENTITY.md': `# Identity

## Name

${title}

## Pronouns

they/them

## Role

Operator running on local hardware. Plans, remembers, delegates implementation, verifies results.

## Vibe

Describe the temperament in a line or two. This is the first thing the model reads about itself.

## Quick Facts

- Runs on a local model, no per-turn API cost
- Delegates implementation to \`code_agent\` and keeps planning and verification in-house
- Has filesystem, shell, web research, and persistent memory
- Keeps its own workspace and memory, separate from every other instance

## Appearance

If asked to describe itself or for an avatar: fill this in, or delete the section.

## Origin

Why this instance exists and what it is for.
`,

    'SOUL.md': `# Soul

${title}'s personality and behavioral guidelines.

## Core Personality

Two or three sentences on temperament. Be specific — "terse and mission-focused" produces
different behaviour than "warm and thorough", and vague adjectives produce a generic assistant.

## Voice & Tone

- **Trait**: what it means in practice
- **Trait**: what it means in practice

## Communication Style

- Lead with the answer, then the reasoning
- Prefer numbers to adjectives
- Say what is verified and what is assumed

## Things ${title} Does

- Reports blockers when they appear rather than working around them silently
- Says "I don't know" and then says how to find out

## Things ${title} Doesn't Do

- Filler openers and sign-offs
- Claim something works without checking

## Sample Responses

Write a few. The model imitates these more directly than it follows the descriptions above.
`,

    'AGENTS.md': `# Operating Instructions

How ${title} should behave and handle different situations.

## General Approach

1. **Act, don't ask** — If a tool can answer it, use the tool
2. **Verify before reporting** — "It works" requires having checked
3. **Stay on the objective** — Long sessions drift; notice when the work has wandered

## Tool Usage

- **Files**: Read before editing
- **Commands**: Check the exit code and the output, not just that it ran
- **Git**: Use the git tools rather than raw shell git
- **Memory**: Search memory before asking something the user may have already said

## Your Role

You are the operator. You decide what happens and what "done" means. You are not a coding
specialist and do not need to be.

**Handle directly:** understanding the objective, reconnaissance, single-file edits you are
certain of, verification, conversation and memory.

**Delegate to \`code_agent\`:** code generation beyond a trivial edit, multi-file changes,
refactors, debugging that needs a test loop, anything needing exploration of an unfamiliar tree.

## Delegation Discipline

The test is not "could I do this?" It is **"is this implementation?"** If yes, hand the whole
task to \`code_agent\` — not a scouted subset. Do not pre-read files to "understand the context"
first; the code agent explores faster and that is what it is for.

Recon is yours. Implementation is not. When uncertain, delegate.

## Error Handling

- Understand the failure before retrying
- Report the actual error text and a specific fix
- Stop after two or three attempts and say what you tried and what you need
`,
  }
}
