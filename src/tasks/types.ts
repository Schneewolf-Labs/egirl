import type { TaskErrorKind } from './error-classify'

export type TaskKind = 'scheduled' | 'oneshot'
export type TaskStatus = 'proposed' | 'active' | 'paused' | 'done' | 'failed'
export type TaskNotify = 'always' | 'on_change' | 'on_failure' | 'never'
export type RunStatus = 'running' | 'success' | 'failure' | 'skipped'
export type ProposalStatus = 'pending' | 'approved' | 'rejected'

export interface Task {
  id: string
  name: string
  description: string
  kind: TaskKind
  status: TaskStatus
  prompt: string
  memoryContext: string[] | undefined
  memoryCategory: string | undefined
  intervalMs: number | undefined
  cronExpression: string | undefined
  businessHours: string | undefined
  dependsOn: string | undefined
  persistConversation: boolean
  nextRunAt: number | undefined
  lastRunAt: number | undefined
  runCount: number
  maxRuns: number | undefined
  consecutiveFailures: number
  lastErrorKind: TaskErrorKind | undefined
  notify: TaskNotify
  lastResultHash: string | undefined
  channel: string
  channelTarget: string
  createdBy: string
  createdAt: number
  updatedAt: number
}

export interface NewTask {
  name: string
  description: string
  kind: TaskKind
  prompt: string
  memoryContext?: string[]
  memoryCategory?: string
  intervalMs?: number
  cronExpression?: string
  businessHours?: string
  dependsOn?: string
  persistConversation?: boolean
  maxRuns?: number
  notify?: TaskNotify
  channel: string
  channelTarget: string
  createdBy: string
}

export interface TaskRun {
  id: string
  taskId: string
  startedAt: number
  completedAt: number | undefined
  status: RunStatus
  result: string | undefined
  error: string | undefined
  errorKind: TaskErrorKind | undefined
  tokensUsed: number
}

export interface RunResult {
  status: 'success' | 'failure'
  result?: string
  error?: string
  errorKind?: TaskErrorKind
  tokensUsed?: number
}

export interface TaskProposal {
  id: string
  taskId: string
  messageId: string | undefined
  channel: string
  channelTarget: string
  status: ProposalStatus
  rejectedAt: number | undefined
  createdAt: number
}

export interface TaskFilter {
  status?: TaskStatus
  kind?: TaskKind
  channel?: string
}

export interface TaskTransition {
  id: string
  taskId: string
  fromStatus: TaskStatus | 'new'
  toStatus: TaskStatus
  reason: string | undefined
  timestamp: number
}

export interface TasksConfig {
  enabled: boolean
  tickIntervalMs: number
  maxActiveTasks: number
  maxConcurrentTasks: number
  taskTimeoutMs: number
  discoveryEnabled: boolean
  discoveryIntervalMs: number
  idleThresholdMs: number
}
