#!/usr/bin/env bun
/**
 * Scenario harness: drive a real, hermetic egirl instance through a scripted conversation and
 * grade it on artifacts — what was actually sent to the model, DB rows, files — never on a
 * model's opinion of the transcript.
 *
 *   bun bench/scenarios/run.ts --operator stub --reps 2
 *   bun bench/scenarios/run.ts --operator local --upstream http://127.0.0.1:8195 --model qwen --reps 3
 *   bun bench/scenarios/run.ts --only recall-trivial-gate --keep
 *
 * See README.md here for the flags and for how to add a scenario.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../../src/util/logger'
import { heartbeatNoopNoMemories } from './heartbeat-noop-no-memories'
import { STUB_EMBED_DIMS } from './proxy'
import { recallTrivialGate } from './recall-trivial-gate'
import { type RepResult, type RunOptions, runInstanceRep, runPureRep } from './rep'
import { safetyFilterFalsePositives } from './safety-filter-false-positives'
import type { Scenario } from './types'

const HERE = import.meta.dir
const SCENARIOS: Scenario[] = [
  recallTrivialGate,
  heartbeatNoopNoMemories,
  safetyFilterFalsePositives,
]

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : fallback
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`)

const MARK = { pass: '✓', fail: '✗', 'not-meaningful': '–' } as const

/** `name p/n`, with `(k n/a)` when some reps couldn't judge it. */
function checkSummary(name: string, reps: RepResult[]): string {
  const of = reps.map((r) => r.checks.find((c) => c.name === name))
  const passes = of.filter((c) => c?.status === 'pass').length
  const na = of.filter((c) => c?.status === 'not-meaningful').length
  if (na === reps.length) return `${name} n/a`
  return `${name} ${passes}/${reps.length - na}${na ? ` (${na} n/a)` : ''}`
}

async function main() {
  // egirl code the harness calls in-process (seeding, bootstrap) logs at info to stdout; only
  // its warnings belong in the harness's output. The instance's own logs are its stderr tail.
  log.setLevel('warn')
  const operator = arg('operator', 'stub')
  if (operator !== 'stub' && operator !== 'local') {
    console.error('--operator must be stub or local')
    process.exit(2)
  }
  const embeddings = arg('embeddings')
  const opts: RunOptions = {
    operator,
    upstream: arg('upstream', operator === 'local' ? 'http://127.0.0.1:8195' : undefined),
    model: arg('model', operator === 'stub' ? 'stub' : 'local') as string,
    ...(embeddings && { embeddings }),
    embedDims: Number(arg('embed-dims', embeddings ? '2048' : String(STUB_EMBED_DIMS))),
    turnTimeoutMs: Number(arg('turn-timeout', operator === 'stub' ? '120000' : '900000')),
    keep: flag('keep'),
  }
  const reps = Number(arg('reps', '1'))
  const only = arg('only')?.split(',')
  const scenarios = only ? SCENARIOS.filter((s) => only.includes(s.name)) : SCENARIOS
  if (scenarios.length === 0) {
    const have = SCENARIOS.map((s) => s.name).join(', ')
    console.error(`no scenario matches --only ${only?.join(',')}; have: ${have}`)
    process.exit(2)
  }

  const label = arg('label', operator === 'stub' ? 'stub' : opts.model) as string
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = join(HERE, 'results')
  const artifactDir = join(outDir, `${label}-${stamp}`)
  mkdirSync(artifactDir, { recursive: true })

  const results: RepResult[] = []
  for (const s of scenarios) {
    for (let rep = 1; rep <= reps; rep++) {
      const r =
        s.kind === 'pure'
          ? await runPureRep(s, rep, opts)
          : await runInstanceRep(s, rep, opts, artifactDir)
      results.push(r)
      const status = r.error ? 'ERROR' : r.status.toUpperCase()
      console.error(
        `${s.name} rep ${rep}: ${status}${r.error ? `  ${r.error.split('\n')[0]}` : ''}`,
      )
      for (const c of r.checks) {
        if (c.status !== 'pass') console.error(`    ${MARK[c.status]} ${c.name}: ${c.evidence}`)
      }
    }
  }

  const outPath = join(outDir, `${label}-${stamp}.json`)
  const record = { label, operator, upstream: opts.upstream, model: opts.model, reps, results }
  writeFileSync(outPath, JSON.stringify(record, null, 1))

  console.log('')
  for (const s of scenarios) {
    const mine = results.filter((r) => r.scenario === s.name)
    const passes = mine.filter((r) => r.status === 'pass').length
    const na = mine.filter((r) => r.status === 'not-meaningful').length
    const names = [...new Set(mine.flatMap((r) => r.checks.map((c) => c.name)))]
    const failing = names.filter((n) =>
      mine.some((r) => r.checks.find((c) => c.name === n)?.status !== 'pass'),
    )
    // A table-driven scenario has dozens of checks; list the ones that aren't clean passes.
    const shown = names.length > 8 ? failing : names
    const detail = shown.map((n) => checkSummary(n, mine)).join(', ')
    const extra =
      names.length > 8 ? `${names.length - failing.length}/${names.length} checks clean; ` : ''
    const naNote = na ? ` (${na} n/a)` : ''
    console.log(`${s.name.padEnd(30)} ${passes}/${mine.length - na}${naNote}   ${extra}${detail}`)
  }
  console.log(`\nwrote ${outPath}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
