/**
 * One repetition of one scenario: build the instance, run setup and steps, grade, tear down.
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
import { type RecordedRequest, type RecordingProxy, startProxy } from './proxy'
import type {
  CheckResult,
  CheckStatus,
  InstanceScenario,
  Operator,
  PureScenario,
  ScenarioState,
  Step,
  StepContext,
  TurnResult,
} from './types'

const SESSION = 'api:scenario'

export interface RunOptions {
  operator: Operator
  upstream?: string
  model: string
  embeddings?: string
  embedDims: number
  turnTimeoutMs: number
  keep: boolean
}

export interface RepResult {
  scenario: string
  rep: number
  operator: string
  model: string
  /**
   * fail if any check failed or the rep errored; else not-meaningful if any check couldn't be
   * judged on this operator (a rep that is only partly judged is not a pass); else pass.
   */
  status: CheckStatus
  checks: CheckResult[]
  turns: Array<Omit<TurnResult, 'requests'>>
  requests_log?: string
  root?: string
  error?: string
  egirl_tail?: string
}

export function repStatus(checks: CheckResult[], error?: string): CheckStatus {
  if (error || checks.length === 0 || checks.some((c) => c.status === 'fail')) return 'fail'
  return checks.some((c) => c.status === 'not-meaningful') ? 'not-meaningful' : 'pass'
}

function readLog(path: string): RecordedRequest[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RecordedRequest)
}

async function sendTurn(url: string, text: string, session: string, timeoutMs: number) {
  const res = await fetch(`${url}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: text, session_id: session }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const body = (await res.json()) as { content?: string; error?: string }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.error ?? JSON.stringify(body)}`)
  return body.content ?? ''
}

async function runStep(step: Step, ctx: StepContext, proxy: RecordingProxy, logPath: string) {
  const before = proxy.count()
  const started = Date.now()
  let reply = ''
  let error: string | undefined
  const isChat = 'text' in step
  const session = isChat ? (step.session ?? SESSION) : undefined
  try {
    reply = isChat
      ? await sendTurn(ctx.url, step.text, session as string, ctx.timeoutMs)
      : await step.run(ctx)
  } catch (e) {
    error = errorMessage(e)
  }
  const result: TurnResult = {
    text: isChat ? step.text : step.action,
    kind: isChat ? 'chat' : 'action',
    ...(session && { session }),
    reply,
    ms: Date.now() - started,
    requests: readLog(logPath).filter((r) => r.seq >= before),
    ...(error && { error }),
  }
  return result
}

export async function runPureRep(
  s: PureScenario,
  rep: number,
  opts: RunOptions,
): Promise<RepResult> {
  const base = { scenario: s.name, rep, operator: opts.operator, model: opts.model, turns: [] }
  try {
    const checks = await s.checks()
    return { ...base, status: repStatus(checks), checks } satisfies RepResult
  } catch (e) {
    const error = errorMessage(e)
    return { ...base, status: 'fail', checks: [], error } satisfies RepResult
  }
}

export async function runInstanceRep(
  s: InstanceScenario,
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
    status: 'fail',
    checks: [],
    turns: [],
  }
  const state: ScenarioState = {}
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
      home: paths.home,
      workspace: paths.workspace,
      operator: opts.operator,
      state,
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
    // Boot does its own model-side work (daily-log indexing embeds); let it finish so the
    // first step's window holds only that step's traffic.
    await proxy.settle(1000)
    const ctx: StepContext = {
      url: inst.url,
      root: paths.root,
      workspace: paths.workspace,
      operator: opts.operator,
      state,
      timeoutMs: opts.turnTimeoutMs,
      settle: () => proxy.settle(),
    }
    const turns: TurnResult[] = []
    for (const step of s.turns) turns.push(await runStep(step, ctx, proxy, logPath))
    // Nothing a step set off in the background may land after the checks have looked.
    await proxy.settle()

    result.turns = turns.map(({ requests: _, ...rest }) => rest)
    result.checks = await s.checks({
      root: paths.root,
      workspace: paths.workspace,
      operator: opts.operator,
      state,
      turns,
      allRequests: readLog(logPath),
    })
    result.status = repStatus(result.checks)
    if (result.status === 'fail') result.egirl_tail = inst.stderrTail().slice(-1500)
  } catch (e) {
    result.error = errorMessage(e)
    result.status = 'fail'
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
