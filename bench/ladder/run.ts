#!/usr/bin/env bun
/**
 * Escalating-difficulty ladder for the operator model.
 *
 * The tool-choice bench grades whether `code_agent` was called. That is the wrong target: if the
 * operator does the job itself and the tests pass, that is the *better* outcome, because it skips
 * a code-agent round trip entirely. Delegation is a strategy, not the goal.
 *
 * So this grades the outcome. Every task resets a small Python fixture to its baseline commit,
 * hands the agent one instruction, and then runs a verification command that either exits 0 or
 * does not. Same property that made hembench work: the program runs, or it doesn't, and no judge
 * is required.
 *
 * The interesting axis is not pass/fail alone but pass/fail against strategy:
 *
 *   self, passed        cheapest good outcome
 *   escalated, passed   tried, recognised it was stuck, asked for help — the behaviour worth training
 *   self, failed        worst case: did it alone, got it wrong
 *   escalated, failed   delegated and still failed
 *
 * Reporting all four is the point. A model that delegates everything scores well on pass rate
 * while being expensive and unhelpful; a model that never delegates scores well until the tasks
 * get hard and then fails silently. The ladder exists to find where each one breaks.
 *
 * Usage:
 *   bun bench/ladder/run.ts --label wichtel
 *   bun bench/ladder/run.ts --label wichtel --levels 1,2,3
 */

import { execSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const HERE = dirname(new URL(import.meta.url).pathname)
const ROOT = join(HERE, '..', '..')
// --repo points the ladder at any resettable git repo; the built-in fixture is the default.
// Generated tasks run against a throwaway clone, never a working tree.
function repoArg(): string {
  const i = process.argv.indexOf('--repo')
  return i !== -1 ? (process.argv[i + 1] as string) : join(HERE, 'fixture')
}
const FIXTURE = repoArg()
// The fixture lives inside this repo, so resetting it goes through the outer checkout. A repo
// passed with --repo owns its own git dir and resets itself.
const FIXTURE_IN_TREE = FIXTURE.startsWith(join(HERE, 'fixture'))

interface Task {
  id: string
  level: number
  prompt: string
  verify: string
  /** Optional command run in the repo after reset, before the agent sees the prompt. Generated
   *  tasks use it to blank the function the prompt says was removed. */
  setup?: string
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : fallback
}

/**
 * Baseline state for every task: agent edits discarded, new files removed.
 *
 * Reset goes through the *outer* repo rather than a git repo inside the fixture — nesting one
 * would either be a broken gitlink or a submodule, and neither survives a clone cleanly. The
 * fixture is just tracked files, so checkout plus clean restores it exactly.
 */
function resetFixture() {
  if (FIXTURE_IN_TREE) {
    execSync(`git checkout -q -- '${FIXTURE}' && git clean -fdq '${FIXTURE}'`, { cwd: ROOT })
  } else {
    execSync('git checkout -q -- . && git clean -fdq', { cwd: FIXTURE })
  }
}

function runAgent(prompt: string, timeoutMs: number): Promise<{
  ok: boolean
  toolCalls: { name: string }[]
  turns: number
  elapsed: number
  response: string
}> {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn('bun', ['run', 'src/index.ts', 'cli', '-m', prompt, '--json', '--quiet'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', () => {})
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('close', () => {
      clearTimeout(timer)
      const line = out.trim().split('\n').filter(Boolean).pop()
      try {
        const p = JSON.parse(line ?? '')
        resolve({
          ok: p.ok !== false,
          toolCalls: p.tool_calls ?? [],
          turns: p.turns ?? 0,
          elapsed: Date.now() - started,
          response: p.response ?? '',
        })
      } catch {
        resolve({ ok: false, toolCalls: [], turns: 0, elapsed: Date.now() - started, response: '' })
      }
    })
  })
}

/** Did the task actually get done? Runs in the fixture, exit 0 = yes. */
function verify(cmd: string): { passed: boolean; detail: string } {
  try {
    execSync(cmd, { cwd: FIXTURE, stdio: 'pipe', timeout: 120000, shell: '/bin/bash' })
    return { passed: true, detail: '' }
  } catch (e) {
    const err = e as { stderr?: Buffer; stdout?: Buffer }
    const text = `${err.stderr?.toString() ?? ''}${err.stdout?.toString() ?? ''}`.trim()
    return { passed: false, detail: text.split('\n').slice(-2).join(' ').slice(0, 200) }
  }
}

async function main() {
  const label = arg('label')
  if (!label) {
    console.error('usage: bun bench/ladder/run.ts --label <name> [--levels 1,2,3]')
    process.exit(2)
  }
  const timeoutMs = Number(arg('timeout', '900000'))
  const levels = arg('levels')?.split(',').map(Number)
  const tasksPath = arg('tasks', join(HERE, 'tasks.json'))!
  const all: Task[] = JSON.parse(readFileSync(tasksPath, 'utf8')).tasks
  const tasks = levels ? all.filter((t) => levels.includes(t.level)) : all

  const results = []
  for (const t of tasks) {
    resetFixture()
    // Put the repo into the state the prompt describes. A task whose setup fails would otherwise
    // be handed to the agent as already-working code, and pass without the model doing anything.
    if (t.setup) {
      try {
        execSync(t.setup, { cwd: FIXTURE, stdio: 'pipe', shell: '/bin/bash' })
      } catch (e) {
        console.error(`L${t.level} ${t.id.padEnd(24)} SKIP  setup failed: ${(e as Error).message.split('\n')[0]}`)
        continue
      }
    }
    const prompt = t.prompt.replace('{dir}', FIXTURE)
    const run = await runAgent(prompt, timeoutMs)
    const v = verify(t.verify)
    // Capture what the agent actually left behind before the next task wipes it. Failures are
    // the interesting cases — for diagnosis now, and as training material later — and a reset
    // that happens before anyone looks at the diff destroys the only record of what went wrong.
    let diff = ''
    try {
      diff = execSync(`git diff -- '${FIXTURE}'; git ls-files --others --exclude-standard '${FIXTURE}'`, {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 8 << 20,
      })
    } catch {
      diff = '<could not capture diff>'
    }
    // "Escalated" means the code agent was used at all — whether immediately or after the model
    // tried and got stuck. The transcript distinguishes those; the headline number does not.
    const delegated = run.toolCalls.some((c) => c.name === 'code_agent')
    const strategy = delegated ? 'escalated' : 'self'
    const row = {
      id: t.id,
      level: t.level,
      passed: v.passed,
      strategy,
      delegated,
      tool_calls: run.toolCalls.length,
      tools: run.toolCalls.map((c) => c.name),
      turns: run.turns,
      elapsed_ms: run.elapsed,
      agent_ok: run.ok,
      verify_detail: v.detail,
      response: run.response.slice(0, 4000),
      diff: diff.slice(0, 40000),
    }
    results.push(row)
    console.error(
      `L${t.level} ${t.id.padEnd(24)} ${v.passed ? 'PASS' : 'FAIL'}  ${strategy.padEnd(9)}` +
        ` ${row.tool_calls} calls, ${Math.round(run.elapsed / 1000)}s` +
        (v.passed ? '' : `  ${v.detail}`),
    )
  }
  resetFixture()

  const passed = results.filter((r) => r.passed).length
  const quad = {
    self_passed: results.filter((r) => r.passed && !r.delegated).length,
    escalated_passed: results.filter((r) => r.passed && r.delegated).length,
    self_failed: results.filter((r) => !r.passed && !r.delegated).length,
    escalated_failed: results.filter((r) => !r.passed && r.delegated).length,
  }
  console.error(`\n  passed ${passed}/${results.length}`)
  console.error(`  self, passed       ${quad.self_passed}   (cheapest good outcome)`)
  console.error(`  escalated, passed  ${quad.escalated_passed}   (tried then asked for help)`)
  console.error(`  self, failed       ${quad.self_failed}   (did it alone, got it wrong)`)
  console.error(`  escalated, failed  ${quad.escalated_failed}`)

  const outDir = join(HERE, 'results')
  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, `${label}.json`)
  writeFileSync(outPath, JSON.stringify({ label, passed, total: results.length, quad, results }, null, 1))
  console.error(`\nwrote ${outPath}`)
}

main()
