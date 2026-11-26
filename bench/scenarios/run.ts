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

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryManager, LlamaCppEmbeddings, type MemoryManager } from '../../src/memory'
import { errorMessage } from '../../src/util/errors'
import {
  baseConfig,
  deepMerge,
  freePort,
  type Instance,
  instanceEnv,
  makePaths,
  startInstance,
  writeConfig,
} from './instance'
import { type RecordedRequest, STUB_EMBED_DIMS, startProxy } from './proxy'
import { recallTrivialGate } from './recall-trivial-gate'
import type { CheckResult, Scenario, TurnResult } from './types'

const HERE = import.meta.dir
const SCENARIOS: Scenario[] = [recallTrivialGate]
const SESSION = 'api:scenario'

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : fallback
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`)

interface RunOptions {
  operator: 'stub' | 'local'
  upstream?: string
  model: string
  embeddings?: string
  embedDims: number
  turnTimeoutMs: number
  keep: boolean
}

interface RepResult {
  scenario: string
  rep: number
  operator: string
  model: string
  passed: boolean
  checks: CheckResult[]
  turns: Array<{ text: string; session: string; reply: string; ms: number; error?: string }>
  requests_log?: string
  root?: string
  error?: string
  egirl_tail?: string
}

function readLog(path: string): RecordedRequest[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RecordedRequest)
}

async function sendTurn(inst: Instance, text: string, session: string, timeoutMs: number) {
  const res = await fetch(`${inst.url}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: text, session_id: session }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const body = (await res.json()) as { content?: string; error?: string }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.error ?? JSON.stringify(body)}`)
  return body.content ?? ''
}

async function runRep(
  s: Scenario,
  rep: number,
  opts: RunOptions,
  artifactDir: string,
): Promise<RepResult> {
  const paths = makePaths(mkdtempSync(join(tmpdir(), `egirl-scn-${s.name}-`)))
  const logPath = join(paths.root, 'requests.jsonl')
  const proxy = startProxy({
    logPath,
    embedDims: opts.embedDims,
    ...(opts.operator === 'local' && opts.upstream && { upstream: opts.upstream }),
    ...(opts.embeddings && { embeddingsUpstream: opts.embeddings }),
  })
  const result: RepResult = {
    scenario: s.name,
    rep,
    operator: opts.operator,
    model: opts.model,
    passed: false,
    checks: [],
    turns: [],
  }
  let inst: Instance | undefined
  try {
    const embeddings = { endpoint: proxy.url, dims: opts.embedDims }
    const apiPort = await freePort()
    writeConfig(
      paths,
      deepMerge(baseConfig(paths, apiPort), s.config({ proxyUrl: proxy.url, embeddings })),
    )

    // Setup runs before the instance exists, so seeding never races its own startup.
    let memory: MemoryManager | undefined
    await s.setup?.({
      root: paths.root,
      workspace: paths.workspace,
      memory: () => {
        memory ??= createMemoryManager({
          workspaceDir: paths.workspace,
          embeddings: new LlamaCppEmbeddings(embeddings.endpoint, 'scenario-embed', {
            dimensions: embeddings.dims,
          }),
          embeddingDimensions: embeddings.dims,
        })
        return memory
      },
    })
    memory?.close()

    // One retry: roughly one Bun start in twenty-five stalls before reaching main (see the
    // startup-stall guard in bench/ladder/run.ts), which is not the scenario failing.
    const env = instanceEnv(paths, proxy.url, opts.model)
    inst = await startInstance(paths, apiPort, env).catch((e) => {
      console.error(`  boot failed, retrying once: ${errorMessage(e).split('\n')[0]}`)
      return startInstance(paths, apiPort, env)
    })
    const turns: TurnResult[] = []
    for (const t of s.turns) {
      const session = t.session ?? SESSION
      const before = proxy.count()
      const started = Date.now()
      let reply = ''
      let error: string | undefined
      try {
        reply = await sendTurn(inst, t.text, session, opts.turnTimeoutMs)
      } catch (e) {
        error = errorMessage(e)
      }
      const requests = readLog(logPath).filter((r) => r.seq >= before)
      turns.push({
        text: t.text,
        session,
        reply,
        ms: Date.now() - started,
        requests,
        ...(error && { error }),
      })
    }
    result.turns = turns.map(({ requests: _, ...rest }) => rest)
    result.checks = s.checks({
      root: paths.root,
      workspace: paths.workspace,
      turns,
      allRequests: readLog(logPath),
    })
    result.passed = result.checks.length > 0 && result.checks.every((c) => c.passed)
    if (!result.passed) result.egirl_tail = inst.stderrTail().slice(-1500)
  } catch (e) {
    result.error = errorMessage(e)
  } finally {
    await inst?.stop()
    proxy.stop()
    const saved = join(artifactDir, `${s.name}-rep${rep}.requests.jsonl`)
    if (existsSync(logPath)) {
      copyFileSync(logPath, saved)
      result.requests_log = saved
    }
    if (opts.keep) result.root = paths.root
    else rmSync(paths.root, { recursive: true, force: true })
  }
  return result
}

async function main() {
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
    console.error(
      `no scenario matches --only ${only?.join(',')}; have: ${SCENARIOS.map((s) => s.name).join(', ')}`,
    )
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
      const r = await runRep(s, rep, opts, artifactDir)
      results.push(r)
      const failed = r.checks.filter((c) => !c.passed)
      const status = r.error ? 'ERROR' : r.passed ? 'PASS' : 'FAIL'
      console.error(
        `${s.name} rep ${rep}: ${status}${r.error ? `  ${r.error.split('\n')[0]}` : ''}`,
      )
      for (const c of failed) console.error(`    ✗ ${c.name}: ${c.evidence}`)
    }
  }

  const outPath = join(outDir, `${label}-${stamp}.json`)
  writeFileSync(
    outPath,
    JSON.stringify(
      { label, operator, upstream: opts.upstream, model: opts.model, reps, results },
      null,
      1,
    ),
  )

  console.log('')
  for (const s of scenarios) {
    const mine = results.filter((r) => r.scenario === s.name)
    const passes = mine.filter((r) => r.passed).length
    const checkNames = [...new Set(mine.flatMap((r) => r.checks.map((c) => c.name)))]
    const perCheck = checkNames
      .map(
        (n) =>
          `${n} ${mine.filter((r) => r.checks.find((c) => c.name === n)?.passed).length}/${mine.length}`,
      )
      .join(', ')
    console.log(`${s.name.padEnd(24)} ${passes}/${mine.length}   ${perCheck}`)
  }
  console.log(`\nwrote ${outPath}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
