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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const HERE = dirname(new URL(import.meta.url).pathname)
const ROOT = join(HERE, '..', '..')
// Every task runs under the hermetic bench config unless the caller points EGIRL_CONFIG
// elsewhere. Its workspace is wiped at the start of each ladder run; see egirl.bench.toml.
const BENCH_CONFIG = process.env.EGIRL_CONFIG ?? join(HERE, 'egirl.bench.toml')
const BENCH_WORKSPACE = join(homedir(), '.egirl', 'bench')
// Time allowed for egirl to boot and write an (empty) transcript file; see the stall guard.
const STARTUP_MS = 60_000
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

/** Task files refer to helper scripts next to this runner as `{ladder}/…` rather than pinning
 *  the checkout they were generated from. */
function fillLadder(cmd: string): string {
  return cmd.replaceAll('{ladder}', HERE)
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

function runAgent(
  prompt: string,
  timeoutMs: number,
  maxTurns: number,
  transcriptPath: string,
): Promise<{
  ok: boolean
  toolCalls: { name: string }[]
  turns: number
  elapsed: number
  response: string
  stderr: string
  stalled?: boolean
}> {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(
      'bun',
      [
        'run',
        'src/index.ts',
        'cli',
        '-m',
        prompt,
        '--json',
        '--quiet',
        '--transcript',
        transcriptPath,
        '--max-turns',
        String(maxTurns),
      ],
      {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          EGIRL_CONFIG: BENCH_CONFIG,
          // Pin sampling, as the tool bench does. Without this the same task flips between runs —
          // two passes over the same ten tasks gave 8/10 and 9/10, and disagreed on which
          // episodes counted as escalation trajectories. When the output is training data rather
          // than a score, that means the dataset itself is partly a sample of noise.
          EGIRL_LOCAL_TEMPERATURE: process.env.EGIRL_LOCAL_TEMPERATURE ?? '0',
        },
      },
    )
    // Startup-stall guard. Roughly one run in twenty-five never reaches its first model turn:
    // the JS thread idles while a Bun pool thread spins at 100% with a module file half-loaded
    // (seen live: `Bun Pool 7` at 337s CPU, main thread in ep_poll, fd open on
    // zod/v4/locales/ru.js). egirl creates the transcript file as soon as the runtime is up, so
    // a run with no transcript after STARTUP_MS is that hang, not a slow model; kill it and let
    // the caller retry rather than burn the whole task timeout.
    let stalled = false
    const startupTimer = setTimeout(() => {
      if (!existsSync(transcriptPath)) {
        stalled = true
        child.kill('SIGKILL')
      }
    }, STARTUP_MS)
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    // Keep the end of stderr: a run that times out with no tool calls and no transcript has
    // left nothing else to diagnose from, and egirl logs why it stalled there.
    let err = ''
    child.stderr.on('data', (d) => {
      err = (err + d).slice(-2000)
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('close', () => {
      clearTimeout(timer)
      clearTimeout(startupTimer)
      if (stalled) {
        resolve({ ok: false, toolCalls: [], turns: 0, elapsed: Date.now() - started, response: '', stderr: err, stalled: true })
        return
      }
      const line = out.trim().split('\n').filter(Boolean).pop()
      try {
        const p = JSON.parse(line ?? '')
        resolve({
          ok: p.ok !== false,
          toolCalls: p.tool_calls ?? [],
          turns: p.turns ?? 0,
          elapsed: Date.now() - started,
          response: p.response ?? '',
          stderr: err,
        })
      } catch {
        resolve({
          ok: false,
          toolCalls: [],
          turns: 0,
          elapsed: Date.now() - started,
          response: '',
          stderr: err,
        })
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
    const lines = text.split('\n')
    // Name the failing tests, not just the count: pytest's last two lines are the -x banner and
    // the summary, which says "1 failed" without saying which, and whether the same test fails
    // across runs is the first thing worth knowing about a failure.
    const named = lines.filter((l) => /^(FAILED|ERROR) |^error:|^\s*✗|^\(fail\)/.test(l)).slice(0, 4)
    const tail = lines.slice(-2).join(' ')
    return { passed: false, detail: [...named, tail].join(' ; ').slice(0, 600) }
  }
}

async function main() {
  const label = arg('label')
  if (!label) {
    console.error('usage: bun bench/ladder/run.ts --label <name> [--levels 1,2,3]')
    process.exit(2)
  }
  const timeoutMs = Number(arg('timeout', '900000'))
  // The one-shot default of 10 turns is a chat cap, not a task cap: B1.1 under the native tool
  // shape reads, edits and re-runs the tests in 9-11 turns and was being cut off with the fix
  // already made. 24 matches render_sft.py's budget, so a run that finishes here is a row.
  const maxTurns = Number(arg('max-turns', '24'))
  const levels = arg('levels')?.split(',').map(Number)
  const tasksPath = arg('tasks', join(HERE, 'tasks.json'))!
  const all: Task[] = JSON.parse(readFileSync(tasksPath, 'utf8')).tasks
  const tasks = levels ? all.filter((t) => levels.includes(t.level)) : all

  // Fresh bench workspace: the previous run's memory.db and audit log would otherwise carry
  // into this one. Only done for the stock bench config — a caller-supplied EGIRL_CONFIG owns
  // its own workspace and we do not know what else lives there.
  if (!process.env.EGIRL_CONFIG) rmSync(BENCH_WORKSPACE, { recursive: true, force: true })
  // One JSONL transcript per task: every model round trip as the provider saw it. This is the
  // raw material for training data, where the results JSON is only the scorecard.
  const transcriptDir = join(HERE, 'transcripts', label)
  mkdirSync(transcriptDir, { recursive: true })

  const results = []
  for (const t of tasks) {
    resetFixture()
    // Put the repo into the state the prompt describes. A task whose setup fails would otherwise
    // be handed to the agent as already-working code, and pass without the model doing anything.
    if (t.setup) {
      try {
        execSync(fillLadder(t.setup), { cwd: FIXTURE, stdio: 'pipe', shell: '/bin/bash' })
      } catch (e) {
        console.error(`L${t.level} ${t.id.padEnd(24)} SKIP  setup failed: ${(e as Error).message.split('\n')[0]}`)
        continue
      }
    }
    const prompt = t.prompt.replace('{dir}', FIXTURE)
    const transcript = join(transcriptDir, `${t.id}.jsonl`)
    let run = await runAgent(prompt, timeoutMs, maxTurns, transcript)
    if (run.stalled) {
      console.error(`L${t.level} ${t.id.padEnd(24)} STALL  no transcript after ${STARTUP_MS / 1000}s, retrying once`)
      resetFixture()
      if (t.setup) execSync(fillLadder(t.setup), { cwd: FIXTURE, stdio: 'pipe', shell: '/bin/bash' })
      run = await runAgent(prompt, timeoutMs, maxTurns, transcript)
    }
    const v = verify(fillLadder(t.verify))
    // Capture what the agent actually left behind before the next task wipes it. Failures are
    // the interesting cases — for diagnosis now, and as training material later — and a reset
    // that happens before anyone looks at the diff destroys the only record of what went wrong.
    let diff = ''
    try {
      // Run inside whichever repo owns the working tree. Pointing git at a path outside its
      // own checkout fails with "is outside repository", which silently discarded the diff for
      // every task in the first generated-task run — losing exactly the material the ladder
      // exists to collect.
      diff = FIXTURE_IN_TREE
        ? execSync(`git diff -- '${FIXTURE}'; git ls-files --others --exclude-standard '${FIXTURE}'`, {
            cwd: ROOT,
            encoding: 'utf8',
            maxBuffer: 8 << 20,
          })
        : execSync('git diff; git ls-files --others --exclude-standard', {
            cwd: FIXTURE,
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
      transcript,
      // Only worth keeping when something went wrong; a pass has its transcript.
      ...(v.passed ? {} : { stderr: run.stderr }),
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
