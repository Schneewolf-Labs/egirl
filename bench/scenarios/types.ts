import type { MemoryManager } from '../../src/memory'
import type { RecordedRequest } from './proxy'

/** A TOML table as a plain object; serialized with smol-toml. */
export type TomlTable = Record<string, unknown>

export interface ConfigContext {
  /** The recording proxy; also the stub embedder unless --embeddings is given */
  proxyUrl: string
  /** Where embeddings should be requested, and at what width */
  embeddings: { endpoint: string; dims: number }
}

export interface SetupContext {
  root: string
  workspace: string
  /**
   * The instance's own memory store, opened through MemoryManager with the same embedder the
   * instance will use. Opened lazily, closed by the runner before egirl starts.
   */
  memory(): MemoryManager
}

export interface Turn {
  text: string
  /** Defaults to the scenario's one session */
  session?: string
}

export interface TurnResult {
  text: string
  session: string
  reply: string
  ms: number
  error?: string
  /** Everything the proxy recorded while this turn was in flight */
  requests: RecordedRequest[]
}

export interface CheckContext {
  root: string
  workspace: string
  turns: TurnResult[]
  /** Every request the proxy recorded, setup included */
  allRequests: RecordedRequest[]
}

export interface CheckResult {
  name: string
  passed: boolean
  /** Short and concrete: the offending text, or what was looked at and found clean */
  evidence: string
}

export interface Scenario {
  name: string
  description: string
  /**
   * Subsystems this scenario switches on, deep-merged over the hermetic base config. The base
   * has memory recall, extraction, tasks, conversation persistence and every network tool off.
   */
  config(ctx: ConfigContext): TomlTable
  setup?(ctx: SetupContext): Promise<void>
  turns: Turn[]
  checks(ctx: CheckContext): CheckResult[]
}
