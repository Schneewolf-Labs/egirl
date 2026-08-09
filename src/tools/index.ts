export {
  type CodeAgentConfig,
  createBrowserTools,
  createCodeAgentTool,
  createGitHubTools,
  createMemoryTools,
  createPeerTools,
  createProcessTools,
  createTaskTools,
  createWebSearchTool,
  editTool,
  execTool,
  type GitHubConfig,
  gitCommitTool,
  gitDiffTool,
  gitLogTool,
  gitShowTool,
  gitStatusTool,
  globTool,
  type PeerToolsConfig,
  readTool,
  screenshotTool,
  type WebSearchConfig,
  webResearchTool,
  writeTool,
} from './builtin'
export {
  type ConfirmCallback,
  createToolExecutor,
  type ExecutionContext,
  ToolExecutor,
} from './executor'
export {
  buildToolsSection,
  createToolResponseMessage,
  formatToolCall,
  formatToolDefinition,
  formatToolResponse,
  formatToolResponses,
  hasToolCalls,
  parseToolCalls,
} from './format'
export {
  createProcessRegistry,
  type ProcessRegistry,
  type ProcessSnapshot,
  type ProcessStatus,
} from './process-registry'
export type { Tool, ToolDefinition, ToolResult } from './types'

import type { BrowserManager } from '../browser'
import type { RuntimeConfig } from '../config'
import type { MemoryManager } from '../memory'
import { log } from '../util/logger'
import {
  type CodeAgentConfig,
  createBrowserTools,
  createCodeAgentTool,
  createGitHubTools,
  createMemoryTools,
  createPeerTools,
  createProcessTools,
  createWebSearchTool,
  editTool,
  execTool,
  type GitHubConfig,
  gitCommitTool,
  gitDiffTool,
  gitLogTool,
  gitShowTool,
  gitStatusTool,
  globTool,
  readTool,
  screenshotTool,
  webResearchTool,
  writeTool,
} from './builtin'
import { createToolExecutor } from './executor'
import type { ProcessRegistry } from './process-registry'
import type { Tool, ToolResult } from './types'

const MEMORY_NOT_INITIALIZED =
  'Memory system not initialized. Start egirl with embeddings configured.'

function memoryStub(name: string, description: string, requiredParam: string): Tool {
  return {
    definition: {
      name,
      description,
      parameters: {
        type: 'object',
        properties: { [requiredParam]: { type: 'string', description: `The ${requiredParam}` } },
        required: [requiredParam],
      },
    },
    async execute(): Promise<ToolResult> {
      return { success: false, output: MEMORY_NOT_INITIALIZED }
    },
  }
}

/**
 * Create tool executor with tools gated by config toggles.
 * Each tool category can be enabled/disabled via [tools] in egirl.toml.
 * System-level gates (MemoryManager, GitHubConfig, etc.) still apply on top.
 */
export function createDefaultToolExecutor(
  config: RuntimeConfig,
  memory?: MemoryManager,
  codeAgent?: CodeAgentConfig,
  github?: GitHubConfig,
  browser?: BrowserManager,
  processRegistry?: ProcessRegistry,
) {
  const executor = createToolExecutor()
  const t = config.tools

  /**
   * Five tool groups need a [tools] flag AND a dependency, and when the dependency is absent
   * they used to just... not exist. No message, no stub, nothing to notice. `web_search`
   * defaults to TRUE while needing a [searxng] url, so the DEFAULT install silently has no
   * web search at all -- which is how this audit started.
   *
   * The memory branch below already gets this right by registering explanatory stubs. This is
   * the cheap version of the same idea for the rest: say it once, at startup, naming both the
   * flag and what is missing, and how to silence it.
   */
  const missingDep = (flag: string, needs: string) => {
    log.warn(
      'tools',
      `[tools] ${flag} = true but ${needs} — those tools are NOT registered. ` +
        `Configure it, or set ${flag} = false to silence this.`,
    )
  }

  // File tools (read, write, edit, glob)
  if (t.files) {
    executor.registerAll([readTool, writeTool, editTool, globTool])
  }

  // Shell execution
  if (t.exec) {
    executor.register(execTool)
  }

  // Background process registry (start/list/output/send_input/stop)
  if (t.process && processRegistry) {
    const pt = createProcessTools(processRegistry)
    executor.registerAll([
      pt.processStartTool,
      pt.processListTool,
      pt.processOutputTool,
      pt.processSendInputTool,
      pt.processStopTool,
    ])
  } else if (t.process) missingDep('process', 'no process registry was created')

  // Git tools
  if (t.git) {
    executor.registerAll([gitStatusTool, gitDiffTool, gitLogTool, gitCommitTool, gitShowTool])
  }

  // Screenshot
  if (t.screenshot) {
    executor.register(screenshotTool)
  }

  // Web research
  if (t.webResearch) {
    executor.register(webResearchTool)
  }

  // Peer agents (agent-to-agent messaging over the egirl-peer HTTP protocol).
  // No warning when unconfigured — unlike web_search, having no peers is the normal state.
  if (t.peers && config.peers && config.peers.length > 0) {
    const pt = createPeerTools({
      selfName: config.source.instance ?? 'egirl',
      peers: config.peers,
    })
    executor.registerAll([pt.peerMessageTool, pt.peerListTool])
  }

  // Web search (available if searxng is configured)
  if (t.webSearch && config.searxng) {
    executor.register(
      createWebSearchTool({
        url: config.searxng.url,
        apiKey: config.searxng.apiKey,
      }),
    )
  } else if (t.webSearch) missingDep('web_search', 'no [searxng] url is configured')

  // Memory tools (functional if MemoryManager provided)
  if (t.memory) {
    if (memory) {
      const tools = createMemoryTools(memory)
      executor.registerAll([
        tools.memorySearchTool,
        tools.memoryGetTool,
        tools.memorySetTool,
        tools.memoryDeleteTool,
        tools.memoryListTool,
        tools.memoryRecallTool,
      ])
    } else {
      // Register stubs that return helpful error messages
      executor.registerAll([
        memoryStub(
          'memory_search',
          'Search through stored memories using semantic search',
          'query',
        ),
        memoryStub('memory_get', 'Retrieve a specific memory by key', 'key'),
      ])
    }
  }

  // Code agent tool (available if claude code config provided)
  if (t.codeAgent && codeAgent) {
    executor.register(createCodeAgentTool(codeAgent))
  } else if (t.codeAgent)
    missingDep('code_agent', 'no [channels.code_agent] or [channels.claude_code] config was found')

  // GitHub tools (available if GITHUB_TOKEN is set)
  if (t.github && github) {
    const gh = createGitHubTools(github)
    executor.registerAll([
      gh.ghPrListTool,
      gh.ghPrViewTool,
      gh.ghPrCreateTool,
      gh.ghPrReviewTool,
      gh.ghPrCommentTool,
      gh.ghIssueListTool,
      gh.ghIssueViewTool,
      gh.ghIssueCommentTool,
      gh.ghIssueUpdateTool,
      gh.ghCiStatusTool,
      gh.ghBranchCreateTool,
      gh.ghReleaseListTool,
    ])
  } else if (t.github)
    missingDep('github', 'no [github] config was found (needs GITHUB_TOKEN and a [github] section)')

  // Browser tools (available if BrowserManager provided)
  if (t.browser && browser) {
    const bt = createBrowserTools(browser)
    executor.registerAll([
      bt.browserNavigateTool,
      bt.browserClickTool,
      bt.browserFillTool,
      bt.browserSnapshotTool,
      bt.browserScreenshotTool,
      bt.browserSelectTool,
      bt.browserCheckTool,
      bt.browserHoverTool,
      bt.browserWaitTool,
      bt.browserEvalTool,
      bt.browserCloseTool,
    ])
  } else if (t.browser) missingDep('browser', 'no browser manager was created')

  return executor
}
