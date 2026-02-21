export {
  type CodeAgentConfig,
  createBrowserTools,
  createCodeAgentTool,
  createGitHubTools,
  createMemoryTools,
  createTaskTools,
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
export {
  type ConfirmCallback,
  createToolExecutor,
  type ExecutionContext,
  ToolExecutor,
} from './executor'
export * from './format'
export * from './types'

import type { BrowserManager } from '../browser'
import type { RuntimeConfig } from '../config'
import type { MemoryManager } from '../memory'
import { builtinWorkflows, createWorkflowTool } from '../workflows'
import {
  type CodeAgentConfig,
  createBrowserTools,
  createCodeAgentTool,
  createGitHubTools,
  createMemoryTools,
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
) {
  const executor = createToolExecutor()
  const t = config.tools

  // File tools (read, write, edit, glob)
  if (t.files) {
    executor.registerAll([readTool, writeTool, editTool, globTool])
  }

  // Shell execution
  if (t.exec) {
    executor.register(execTool)
  }

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
  }

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
  }

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
  }

  // Workflow tool (registered last — it references the executor to call other tools)
  executor.register(createWorkflowTool(executor, builtinWorkflows))

  return executor
}
