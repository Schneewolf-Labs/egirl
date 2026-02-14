import { join } from 'path'
import { BrowserManager, type BrowserManager as BrowserManagerType } from './browser'
import type { RuntimeConfig } from './config'
import { type ConversationStore, createConversationStore } from './conversation'
import { createMemoryManager, type MemoryManager, Qwen3VLEmbeddings } from './memory'
import { createProviderRegistry, type ProviderRegistry } from './providers'
import { createRouter, type Router } from './routing'
import { buildSafetyConfig } from './safety/config-bridge'
import { createSkillManager } from './skills'
import type { Skill } from './skills/types'
import { createTaskStore, type TaskStore } from './tasks'
import {
  type CodeAgentConfig,
  createDefaultToolExecutor,
  type GitHubConfig,
  type ToolExecutor,
} from './tools'
import { createStatsTracker, type StatsTracker } from './tracking'
import { log } from './util/logger'

/**
 * Shared services created during app bootstrap.
 * Each command runner picks what it needs from this bag.
 */
export interface AppServices {
  config: RuntimeConfig
  providers: ProviderRegistry
  memory: MemoryManager | undefined
  conversations: ConversationStore | undefined
  taskStore: TaskStore | undefined
  router: Router
  toolExecutor: ToolExecutor
  stats: StatsTracker
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
    const embeddings = new Qwen3VLEmbeddings(embeddingsConfig.endpoint, embeddingsConfig.dimensions)

    const memory = createMemoryManager({
      workspaceDir: config.workspace.path,
      embeddings,
      embeddingDimensions: embeddingsConfig.dimensions,
    })

    log.info(
      'main',
      `Memory system initialized: ${embeddingsConfig.model} @ ${embeddingsConfig.endpoint}`,
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
  const skillManager = createSkillManager()
  const bundledDir = join(import.meta.dir, 'skills', 'bundled')
  const allDirs = [bundledDir, ...config.skills.dirs]

  try {
    await skillManager.loadFromDirectories(allDirs)
    const enabled = skillManager.getEnabled()
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
  const conversations = createConversations(config)
  const taskStore = createTasks(config)
  const skills = await loadSkills(config)
  const router = createRouter(config, skills)
  const browser = new BrowserManager()
  const toolExecutor = createDefaultToolExecutor(
    memory,
    getCodeAgentConfig(config),
    getGitHubConfig(config),
    browser,
  )
  toolExecutor.setSafety(buildSafetyConfig(config))
  const stats = createStatsTracker()

  return {
    config,
    providers,
    memory,
    conversations,
    taskStore,
    router,
    toolExecutor,
    stats,
    skills,
    browser,
  }
}
