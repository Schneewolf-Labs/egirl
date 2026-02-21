import { join } from 'path'
import { BrowserManager, type BrowserManager as BrowserManagerType } from './browser'
import type { RuntimeConfig } from './config'
import { type ConversationStore, createConversationStore } from './conversation'
import { createEnergyBudget, type EnergyBudget } from './energy'
import {
  createEmbeddingProvider,
  createMemoryManager,
  createWorkingMemory,
  indexDailyLogs,
  type MemoryManager,
  type WorkingMemory,
} from './memory'
import { createProviderRegistry, type ProviderRegistry } from './providers'
import { createRouter, type Router } from './routing'
import { buildSafetyConfig } from './safety/config-bridge'
import { loadSkillsFromDirectories } from './skills'
import type { Skill } from './skills/types'
import { createTaskStore, type TaskStore } from './tasks'
import {
  type CodeAgentConfig,
  createDefaultToolExecutor,
  type GitHubConfig,
  type ToolExecutor,
} from './tools'
import { createStatsTracker, type StatsTracker } from './tracking'
import { createTranscriptLogger, type TranscriptLogger } from './tracking/transcript'
import { log } from './util/logger'

/**
 * Shared services created during app bootstrap.
 * Each command runner picks what it needs from this bag.
 */
export interface AppServices {
  config: RuntimeConfig
  providers: ProviderRegistry
  memory: MemoryManager | undefined
  workingMemory: WorkingMemory | undefined
  energy: EnergyBudget | undefined
  conversations: ConversationStore | undefined
  taskStore: TaskStore | undefined
  router: Router
  toolExecutor: ToolExecutor
  stats: StatsTracker
  transcript: TranscriptLogger | undefined
  skills: Skill[]
  browser: BrowserManagerType
}

/**
 * Create conversation store if enabled, run compaction on startup.
 */
export function createConversations(config: RuntimeConfig): ConversationStore | undefined {
  if (!config.conversation.enabled) {
    log.info('main', 'Conversation persistence disabled')
    return undefined
  }

  try {
    const dbPath = join(config.workspace.path, 'conversations.db')
    const store = createConversationStore(dbPath)

    if (config.conversation.compactOnStartup) {
      store.compact({
        maxAgeDays: config.conversation.maxAgeDays,
        maxMessages: config.conversation.maxMessages,
      })
    }

    log.info(
      'main',
      `Conversation persistence enabled (${config.conversation.maxAgeDays}d retention, ${config.conversation.maxMessages} max messages)`,
    )
    return store
  } catch (error) {
    log.warn('main', 'Failed to initialize conversation store:', error)
    return undefined
  }
}

/**
 * Create memory manager with embeddings if configured.
 */
export function createMemory(config: RuntimeConfig): MemoryManager | undefined {
  const embeddingsConfig = config.local.embeddings
  if (!embeddingsConfig) {
    log.info('main', 'No embeddings configured - memory system disabled')
    return undefined
  }

  try {
    const embeddings = createEmbeddingProvider(embeddingsConfig.provider, {
      endpoint: embeddingsConfig.endpoint,
      model: embeddingsConfig.model,
      dimensions: embeddingsConfig.dimensions,
      multimodal: embeddingsConfig.multimodal,
      apiKey: embeddingsConfig.apiKey,
      baseUrl: embeddingsConfig.baseUrl,
    })

    const memory = createMemoryManager({
      workspaceDir: config.workspace.path,
      embeddings,
      embeddingDimensions: embeddingsConfig.dimensions,
    })

    log.info(
      'main',
      `Memory system initialized: ${embeddingsConfig.provider}/${embeddingsConfig.model} @ ${embeddingsConfig.endpoint}`,
    )
    return memory
  } catch (error) {
    log.warn('main', 'Failed to initialize memory system:', error)
    return undefined
  }
}

/**
 * Extract CodeAgentConfig from RuntimeConfig if Claude Code channel is configured.
 */
export function getCodeAgentConfig(config: RuntimeConfig): CodeAgentConfig | undefined {
  const cc = config.channels.claudeCode
  if (!cc) return undefined
  return {
    permissionMode: cc.permissionMode,
    model: cc.model,
    workingDir: cc.workingDir,
    maxTurns: cc.maxTurns,
  }
}

/**
 * Extract GitHubConfig from RuntimeConfig if GITHUB_TOKEN is set.
 */
export function getGitHubConfig(config: RuntimeConfig): GitHubConfig | undefined {
  if (!config.github) return undefined
  return {
    token: config.github.token,
    defaultOwner: config.github.defaultOwner,
    defaultRepo: config.github.defaultRepo,
  }
}

/**
 * Load skills from bundled + configured directories.
 * Bundled skills are loaded first so user directories can override them.
 */
async function loadSkills(config: RuntimeConfig): Promise<Skill[]> {
  const bundledDir = join(import.meta.dir, 'skills', 'bundled')
  const allDirs = [bundledDir, ...config.skills.dirs]

  try {
    const skills = await loadSkillsFromDirectories(allDirs)
    const enabled = skills.filter((s) => s.enabled)
    if (enabled.length > 0) {
      log.info('main', `Skills loaded: ${enabled.map((s) => s.name).join(', ')}`)
    }
    return enabled
  } catch (error) {
    log.warn('main', 'Failed to load skills:', error)
    return []
  }
}

/**
 * Create task store if tasks are enabled.
 */
function createTasks(config: RuntimeConfig): TaskStore | undefined {
  if (!config.tasks.enabled) {
    log.info('main', 'Background tasks disabled')
    return undefined
  }

  try {
    const dbPath = join(config.workspace.path, 'tasks.db')
    const store = createTaskStore(dbPath)
    log.info('main', `Task store initialized (max ${config.tasks.maxActiveTasks} active tasks)`)
    return store
  } catch (error) {
    log.warn('main', 'Failed to initialize task store:', error)
    return undefined
  }
}

/**
 * Bootstrap all shared services from config.
 */
export async function createAppServices(config: RuntimeConfig): Promise<AppServices> {
  const providers = createProviderRegistry(config)

  log.info('main', `Local provider: ${providers.local.name}`)
  if (providers.remote) {
    log.info('main', `Remote provider: ${providers.remote.name}`)
  }

  const memory = createMemory(config)

  // Tier 2: index daily conversation logs into vector search (async, non-blocking)
  if (memory) {
    indexDailyLogs(memory, memory.getFiles()).catch((error) => {
      log.warn('main', 'Daily log indexing failed:', error)
    })
  }

  // Working memory (transient context with TTL)
  let workingMemory: WorkingMemory | undefined
  try {
    const wmDbPath = join(config.workspace.path, 'working-memory.db')
    workingMemory = createWorkingMemory(wmDbPath)
    log.info('main', 'Working memory initialized')
  } catch (error) {
    log.warn('main', 'Failed to initialize working memory:', error)
  }

  // Energy budget (constrains autonomous actions)
  let energy: EnergyBudget | undefined
  if (config.energy.enabled) {
    try {
      const energyDbPath = join(config.workspace.path, 'energy.db')
      energy = createEnergyBudget(energyDbPath, {
        maxEnergy: config.energy.maxEnergy,
        regenPerHour: config.energy.regenPerHour,
      })
      const state = energy.getState()
      log.info(
        'main',
        `Energy budget initialized (${state.current.toFixed(1)}/${state.max} energy, +${state.regenPerHour}/hr)`,
      )
    } catch (error) {
      log.warn('main', 'Failed to initialize energy budget:', error)
    }
  }

  const conversations = createConversations(config)
  const taskStore = createTasks(config)
  const skills = await loadSkills(config)
  const router = createRouter(config, skills)
  const browser = new BrowserManager()
  const toolExecutor = createDefaultToolExecutor(
    config,
    memory,
    getCodeAgentConfig(config),
    getGitHubConfig(config),
    browser,
  )
  toolExecutor.setSafety(buildSafetyConfig(config))
  if (energy) {
    toolExecutor.setEnergy(energy)
  }
  const stats = createStatsTracker()
  const transcript = createTranscriptLogger(config.transcript)

  if (transcript) {
    log.info('main', `JSONL transcripts enabled: ${config.transcript.path}`)
  }

  return {
    config,
    providers,
    memory,
    workingMemory,
    energy,
    conversations,
    taskStore,
    router,
    toolExecutor,
    stats,
    transcript,
    skills,
    browser,
  }
}
