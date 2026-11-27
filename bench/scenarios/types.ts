import type { MemoryManager } from '../../src/memory'
import type { RecordedRequest } from './proxy'

/** A TOML table as a plain object; serialized with smol-toml. */
export type TomlTable = Record<string, unknown>

export type Operator = 'stub' | 'local'

/** Scratch space a scenario carries from setup through its steps to its checks. */
export type ScenarioState = Record<string, unknown>

export interface ConfigContext {
  /** The recording proxy; also the stub embedder unless --embeddings is given */
  proxyUrl: string
  /** Where embeddings should be requested, and at what width */
  embeddings: { endpoint: string; dims: number }
}

export interface SetupContext {
  root: string
  /** The instance's HOME; run anything that reads ~ (git, say) with this as HOME */
  home: string
  workspace: string
  operator: Operator
  state: ScenarioState
  /**
   * The instance's own memory store, opened through MemoryManager with the same embedder the
   * instance will use. Opened lazily, closed by the runner before egirl starts.
   */
  memory(): MemoryManager
}

/** A chat turn: POST /chat with this text. */
export interface ChatTurn {
  text: string
  /** Defaults to the scenario's one session */
  session?: string
}

export interface StepContext {
  /** The instance's HTTP API */
  url: string
  root: string
  workspace: string
  operator: Operator
  state: ScenarioState
  /** Per-step HTTP timeout the runner was given */
  timeoutMs: number
  /** Wait until the model endpoint has gone quiet; see RecordingProxy.settle */
  settle(): Promise<boolean>
}

/** Anything that isn't a chat turn: trigger a task, snapshot a DB. Returns the reply text. */
export interface ActionStep {
  action: string
  run(ctx: StepContext): Promise<string>
}

export type Step = ChatTurn | ActionStep

export interface TurnResult {
  /** The chat text, or the action's name */
  text: string
  kind: 'chat' | 'action'
  session?: string
  reply: string
  ms: number
  error?: string
  /** Everything the proxy recorded while this step was in flight */
  requests: RecordedRequest[]
}

export interface CheckContext {
  root: string
  workspace: string
  operator: Operator
  state: ScenarioState
  turns: TurnResult[]
  /** Every request the proxy recorded, setup included */
  allRequests: RecordedRequest[]
}

/**
 * `not-meaningful`: the check ran, but on this operator its outcome says nothing (a stub reply
 * can't produce what the check looks for). It is neither a pass nor a fail, and a rep made only
 * of such checks doesn't count as passed.
 */
export type CheckStatus = 'pass' | 'fail' | 'not-meaningful'

export interface CheckResult {
  name: string
  status: CheckStatus
  /** Short and concrete: the offending text, or what was looked at and found clean */
  evidence: string
}

export const pass = (name: string, evidence: string): CheckResult => ({
  name,
  status: 'pass',
  evidence,
})
export const fail = (name: string, evidence: string): CheckResult => ({
  name,
  status: 'fail',
  evidence,
})
export const notMeaningful = (name: string, evidence: string): CheckResult => ({
  name,
  status: 'not-meaningful',
  evidence,
})

/** Drives a hermetic egirl instance. */
export interface InstanceScenario {
  kind?: 'instance'
  name: string
  description: string
  /**
   * Subsystems this scenario switches on, deep-merged over the hermetic base config. The base
   * has memory recall, extraction, tasks, conversation persistence and every network tool off.
   */
  config(ctx: ConfigContext): TomlTable
  setup?(ctx: SetupContext): Promise<void>
  turns: Step[]
  checks(ctx: CheckContext): CheckResult[] | Promise<CheckResult[]>
}

/** Calls egirl's code directly; no instance, no proxy, and the operator is irrelevant. */
export interface PureScenario {
  kind: 'pure'
  name: string
  description: string
  checks(): CheckResult[] | Promise<CheckResult[]>
}

export type Scenario = InstanceScenario | PureScenario
