#!/usr/bin/env bun
/**
 * egirl operator bench — drives the real agent and grades what it *did*.
 *
 * The previous bench talked to llama-server directly with a hand-written system prompt. That
 * measures the model, not the product: it cannot see a tool that failed to register, a misparsed
 * config, or a change to egirl's own prompt. A live example — `web_search = true` with no
 * `[searxng] url` configured silently registers no search tools at all, so a model that would
 * have searched correctly scores as a model that refused to. This runner goes through
 * `egirl cli -m ... --json`, so whatever the product actually does is what gets graded.
 *
 * Scoring is deliberately about actions rather than prose:
 *
 *   right_tool   the expected tool was called (or, when expect_tool is null, none was)
 *   args_ok      each arg_checks regex matches the corresponding argument
 *   no_forbid    no forbidden pattern appears in the final response
 *   completed    the run finished without an error
 *
 * A case passes only if all four hold. Answering correctly via the wrong tool is a failure, and
 * that distinction is the entire point of the exercise.
 *
 * Runs write a JSON file. `compare.ts` does a paired McNemar test between two of them, because
 * comparing two pass-rates from 47 binary cases cannot resolve the size of difference that
 * actually shows up between model versions — only the cases where they *disagree* carry
 * information.
 *
 * Usage:
 *   bun bench/run.ts --label wichtel
 *   bun bench/run.ts --label wichtel --axis delegate,no_tool --concurrency 2
 */

import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

interface Case {
  id: string
  axis: string
  user: string
  expect_tool: string | null
  arg_checks?: Record<string, string>
  forbid?: string | string[]
}

interface ToolCall {
  name: string
  arguments?: Record<string, unknown>
  ok?: boolean
  error?: string
  ms?: number
}

interface Outcome {
  id: string
  axis: string
  pass: boolean
  right_tool: boolean
  args_ok: boolean
  no_forbid: boolean
  completed: boolean
  called: string[]
  expected: string | null
  detail: string
  elapsed_ms: number
  response: string
}

const ROOT = join(dirname(new URL(import.meta.url).pathname), '..')

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : fallback
}

/** One case → one `egirl cli -m ... --json` invocation. */
function runCase(c: Case, timeoutMs: number): Promise<Outcome> {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(
      'bun',
      ['run', 'src/index.ts', 'cli', '-m', c.user, '--json', '--quiet'],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, timeoutMs)

    child.on('close', () => {
      clearTimeout(timer)
      const elapsed = Date.now() - started
      let parsed: {
        ok?: boolean
        response?: string
        tool_calls?: ToolCall[]
        error?: string
      } | null = null
      // stdout should hold exactly one JSON object; be forgiving if something else slips in.
      const line = out.trim().split('\n').filter(Boolean).pop()
      try {
        parsed = line ? JSON.parse(line) : null
      } catch {
        parsed = null
      }

      if (!parsed) {
        resolve({
          id: c.id,
          axis: c.axis,
          pass: false,
          right_tool: false,
          args_ok: false,
          no_forbid: false,
          completed: false,
          called: [],
          expected: c.expect_tool,
          detail: `no JSON on stdout (${err.trim().split('\n').pop() ?? 'no stderr'})`,
          elapsed_ms: elapsed,
          response: '',
        })
        return
      }

      const calls = parsed.tool_calls ?? []
      const called = calls.map((t) => t.name)
      const completed = parsed.ok !== false

      // Abstention cases (expect_tool null) require that NO tool was called. Everything else
      // requires the expected tool to appear; extra calls alongside it are tolerated, since a
      // model that reads a file before delegating has not made a wrong decision.
      const right_tool =
        c.expect_tool === null ? called.length === 0 : called.includes(c.expect_tool)

      let args_ok = true
      const argProblems: string[] = []
      if (c.expect_tool && c.arg_checks) {
        const call = calls.find((t) => t.name === c.expect_tool)
        for (const [key, pattern] of Object.entries(c.arg_checks)) {
          const value = call?.arguments?.[key]
          const text = value === undefined || value === null ? '' : String(value)
          let matched = false
          try {
            matched = new RegExp(pattern, 'i').test(text)
          } catch {
            argProblems.push(`<invalid regex for ${key}: ${pattern}>`)
          }
          if (!matched) {
            args_ok = false
            if (!argProblems.length || !argProblems[argProblems.length - 1]?.startsWith('<'))
              argProblems.push(`${key}!~/${pattern}/`)
          }
        }
      }

      const response = parsed.response ?? ''
      let no_forbid = true
      const forbidHits: string[] = []
      // `forbid` is a single pattern in some cases and a list in others. Iterating a string with
      // for..of walks it character by character, which turns "\\b(luna)\\b" into a series of
      // one-character regexes and throws on the lone backslash — killing the whole run at
      // whichever case happened to use the string form.
      const forbidPatterns = Array.isArray(c.forbid) ? c.forbid : c.forbid ? [c.forbid] : []
      for (const pattern of forbidPatterns) {
        try {
          if (new RegExp(pattern, 'i').test(response)) {
            no_forbid = false
            forbidHits.push(pattern)
          }
        } catch {
          // A malformed pattern is a bug in the case file, not a model failure. Surface it
          // without aborting the other 66 cases.
          forbidHits.push(`<invalid regex: ${pattern}>`)
          no_forbid = false
        }
      }

      const detail = [
        right_tool ? '' : `tool: expected ${c.expect_tool ?? 'none'}, got [${called.join(',')}]`,
        argProblems.length ? `args: ${argProblems.join(' ')}` : '',
        forbidHits.length ? `forbid: ${forbidHits.join(' ')}` : '',
        completed ? '' : `error: ${parsed.error ?? 'unknown'}`,
      ]
        .filter(Boolean)
        .join('; ')

      resolve({
        id: c.id,
        axis: c.axis,
        pass: right_tool && args_ok && no_forbid && completed,
        right_tool,
        args_ok,
        no_forbid,
        completed,
        called,
        expected: c.expect_tool,
        detail,
        elapsed_ms: elapsed,
        response: response.slice(0, 2000),
      })
    })
  })
}

async function main() {
  const label = arg('label')
  if (!label) {
    console.error('usage: bun bench/run.ts --label <name> [--axis a,b] [--concurrency N]')
    process.exit(2)
  }
  const casesPath = arg('cases', join(ROOT, 'bench', 'cases.json'))!
  // Concurrency is safe since the stores moved to WAL with a busy timeout (src/util/db.ts).
  // Before that, a second instance hit "database is locked" and silently degraded to
  // keyword-only memory search, so a memory case could fail because an unrelated case held the
  // lock — which changes the behaviour under test rather than merely adding flakiness. Keep this
  // at or below llama-server's --parallel, or the runs just queue on the model instead.
  const concurrency = Number(arg('concurrency', '2'))
  const timeoutMs = Number(arg('timeout', '300000'))
  const axisFilter = arg('axis')?.split(',').map((s) => s.trim())

  const all: Case[] = JSON.parse(readFileSync(casesPath, 'utf8')).cases
  const cases = axisFilter ? all.filter((c) => axisFilter.includes(c.axis)) : all

  console.error(`running ${cases.length} cases, concurrency ${concurrency}`)
  const results: Outcome[] = []
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (cursor < cases.length) {
      const c = cases[cursor++]
      if (!c) break
      const r = await runCase(c, timeoutMs)
      results.push(r)
      const mark = r.pass ? 'OK  ' : 'MISS'
      console.error(
        `[${results.length}/${cases.length}] ${mark} ${r.id.padEnd(26)} ${r.detail}`.trimEnd(),
      )
    }
  })
  await Promise.all(workers)

  results.sort((a, b) => a.id.localeCompare(b.id))
  const passed = results.filter((r) => r.pass).length

  // Per-axis, because a uniform total hides which behaviour moved. Restraint eroding while
  // delegation improves nets out to "no change" on the headline number.
  const axes = new Map<string, { n: number; pass: number }>()
  for (const r of results) {
    const a = axes.get(r.axis) ?? { n: 0, pass: 0 }
    a.n++
    if (r.pass) a.pass++
    axes.set(r.axis, a)
  }

  console.error('')
  for (const [axis, a] of [...axes].sort()) {
    console.error(`  ${axis.padEnd(12)} ${a.pass}/${a.n}`)
  }
  console.error(`  ${'TOTAL'.padEnd(12)} ${passed}/${results.length}`)

  const outDir = join(ROOT, 'bench', 'results')
  mkdirSync(outDir, { recursive: true })
  const outPath = join(outDir, `${label}.json`)
  writeFileSync(
    outPath,
    JSON.stringify({ label, total: results.length, passed, results }, null, 1),
  )
  console.error(`\nwrote ${outPath}`)
}

main()
