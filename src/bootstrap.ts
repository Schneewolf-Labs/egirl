import { join } from 'path'
import { BrowserManager } from './browser'
import type { RuntimeConfig } from './config'
import { type ConversationStore, createConversationStore } from './conversation'
import { createEnergyBudget, type EnergyBudget } from './energy'
import { connectMcpServers, type McpConnection } from './mcp/client'
import {
  createEmbeddingProvider,
  createMemoryManager,
  createWorkingMemory,
  indexDailyLogs,
  type MemoryManager,
  type WorkingMemory,
} from './memory'
import { discoverPeers, mergePeers, registerSelf } from './peers/discovery'
import { createPermissionSupervisor } from './permissions/supervisor'
import { createProviderRegistry, type ProviderRegistry } from './providers'
import { probeServerContextLength } from './providers/context-probe'
import { probeVisionSupport } from './providers/vision-probe'
import { buildSafetyConfig } from './safety/config-bridge'
import { loadSkillsFromDirectories } from './skills'
import type { Skill } from './skills/types'
import { createTaskStore, type TaskStore } from './tasks'
import {
  type CodeAgentConfig,
  createDefaultToolExecutor,
  createDelegationRegistry,
  createProcessRegistry,
  type DelegationRegistry,
  type GitHubConfig,
  type ProcessRegistry,
  type ToolExecutor,
} from './tools'
import { setToolDialect } from './tools/dialects'
import { createStatsTracker, type StatsTracker } from './tracking'
import { initTraces } from './tracking/traces'
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
  toolExecutor: ToolExecutor
  stats: StatsTracker
  transcript: TranscriptLogger | undefined
  skills: Skill[]
  mcpConnections: McpConnection[]
  browser: BrowserManager
  processRegistry: ProcessRegistry
  delegationRegistry: DelegationRegistry
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
 * Extract CodeAgentConfig from RuntimeConfig if a code agent channel is configured.
 */
export function getCodeAgentConfig(config: RuntimeConfig): CodeAgentConfig | undefined {
  const cc = config.channels.codeAgent
  if (!cc) return undefined
  return {
    provider: cc.provider,
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
  // The server's n_ctx is a hard limit — a prompt one token over is rejected wholesale, and
  // token estimates run enough below real counts that a config within a few percent of the
  // server window overflows it in practice. Clamp before anything downstream captures the
  // value (providers, budget tracker, fitting all read config.local.contextLength).
  const serverCtx = await probeServerContextLength(config.local.endpoint, config.local.apiKey)
  if (serverCtx !== undefined && config.local.contextLength > serverCtx) {
    log.warn(
      'bootstrap',
      `Configured context_length (${config.local.contextLength}) exceeds server n_ctx (${serverCtx}) — clamping`,
    )
    config.local.contextLength = serverCtx
  }

  // Pick the tool-calling dialect before anything renders a system prompt: the syntax we
  // ask for has to be the syntax we parse (see src/tools/dialects.ts).
  const dialect = setToolDialect(config.local.toolFormat)
  const providers = createProviderRegistry(config)

  log.info('main', `Local provider: ${providers.local.name} (tool format: ${dialect.name})`)

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
  const browser = new BrowserManager({
    useRealProfile: config.browser.useRealProfile,
    profileStoreDir: join(config.workspace.path, 'browser-profile'),
    ...(config.browser.executablePath ? { executablePath: config.browser.executablePath } : {}),
  })
  const processRegistry = createProcessRegistry()
  const delegationRegistry = createDelegationRegistry()
  const codeAgentConfig = getCodeAgentConfig(config)
  const permissionSupervisor = createPermissionSupervisor({
    config: config.permissionSupervisor,
    // Deliberately the main model: the supervisor decides whether an action is safe to run,
    // which is not side work and must not silently drop to a smaller model.
    localProvider: providers.local,
    memory,
  })
  // Trace store first, so everything below is recorded from the start.
  initTraces(
    join(config.workspace.path, 'traces.db'),
    config.tracing.verbosity,
    config.tracing.retentionDays,
  )

  // Screenshot gating: unset in config means auto-detect from the endpoint's modalities.
  const visionSupported =
    config.tools.screenshot === 'auto'
      ? await probeVisionSupport(config.local.endpoint, config.local.apiKey)
      : undefined
  if (config.tools.screenshot === 'auto') {
    log.info(
      'bootstrap',
      `Endpoint vision support: ${visionSupported} — screenshot tool ${visionSupported ? 'enabled' : 'disabled'}`,
    )
  }
  const toolExecutor = createDefaultToolExecutor(
    config,
    memory,
    codeAgentConfig
      ? { ...codeAgentConfig, localProvider: providers.local, memory, permissionSupervisor }
      : undefined,
    getGitHubConfig(config),
    browser,
    processRegistry,
    skills,
    conversations,
    visionSupported,
    delegationRegistry,
  )
  // MCP tools join the same executor as the builtins, so safety, energy and permissions apply to
  // them identically. A server that is down costs its own tools and nothing else.
  const mcpConnections: McpConnection[] = []
  if (config.mcp?.servers?.length) {
    const { tools: mcpTools, connections } = await connectMcpServers(config.mcp.servers)
    mcpConnections.push(...connections)
    if (mcpTools.length > 0) toolExecutor.registerAll(mcpTools)

    // Peer discovery, once the registry's tools exist. Announce this instance, then resolve
    // peers from the registry and add any the config did not already name. Config wins on a
    // collision: a hand-pinned URL was pinned for a reason.
    //
    // Everything here is best-effort. A registry that is unreachable leaves the statically
    // configured peers exactly as they were -- an optional source of addresses must never be
    // able to stop the agent from starting.
    if (config.peerDiscovery?.enabled) {
      try {
        const registry = config.peerDiscovery.registry ?? 'wald'
        const selfName = config.peerDiscovery.selfName ?? config.source.instance ?? 'egirl'
        await registerSelf({
          tools: mcpTools,
          selfName,
          registry,
          selfUrl: config.peerDiscovery.selfUrl,
          capabilities: config.peerDiscovery.capabilities,
        })
        const found = await discoverPeers({ tools: mcpTools, selfName, registry })
        const before = config.peers?.length ?? 0
        config.peers = mergePeers(config.peers ?? [], found)
        if (config.peers.length !== before) {
          log.info(
            'peers',
            `Discovered ${config.peers.length - before} peer(s) from '${registry}': ${config.peers
              .slice(before)
              .map((p) => p.name)
              .join(', ')}`,
          )
        }
      } catch (error) {
        log.warn(
          'peers',
          `Peer discovery failed, using configured peers: ${(error as Error).message}`,
        )
      }
    }
  }

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
    mcpConnections,
    conversations,
    taskStore,
    toolExecutor,
    stats,
    transcript,
    skills,
    browser,
    processRegistry,
    delegationRegistry,
  }
}
