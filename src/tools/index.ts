export * from './types'
export * from './format'
export { ToolExecutor, createToolExecutor, type ConfirmCallback } from './executor'
export {
  readTool,
  writeTool,
  editTool,
  execTool,
  globTool,
  memorySearchTool,
  memoryGetTool,
  screenshotTool,
  webResearchTool,
  createMemoryTools,
  createCodeAgentTool,
  type CodeAgentConfig,
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitCommitTool,
  gitShowTool,
  createGitHubTools,
  type GitHubConfig,
} from './builtin'

import { createToolExecutor } from './executor'
import type { MemoryManager } from '../memory'
import {
  readTool,
  writeTool,
  editTool,
  execTool,
  globTool,
  memorySearchTool,
  memoryGetTool,
  screenshotTool,
  webResearchTool,
  createMemoryTools,
  createCodeAgentTool,
  type CodeAgentConfig,
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitCommitTool,
  gitShowTool,
  createGitHubTools,
  type GitHubConfig,
} from './builtin'
import { createWorkflowTool, builtinWorkflows } from '../workflows'

/**
 * Create tool executor with all default tools.
 * If MemoryManager is provided, memory tools will be functional.
 * If CodeAgentConfig is provided, the code_agent tool will be available.
 * If GitHubConfig is provided, GitHub integration tools will be available.
 */
export function createDefaultToolExecutor(
  memory?: MemoryManager,
  codeAgent?: CodeAgentConfig,
  github?: GitHubConfig,
) {
  const executor = createToolExecutor()

  // Base tools (always available)
  executor.registerAll([
    readTool,
    writeTool,
    editTool,
    execTool,
    globTool,
    screenshotTool,
    webResearchTool,
    gitStatusTool,
    gitDiffTool,
    gitLogTool,
    gitCommitTool,
    gitShowTool,
  ])

  // Memory tools (functional if MemoryManager provided)
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
    executor.registerAll([memorySearchTool, memoryGetTool])
  }

  // Code agent tool (available if claude code config provided)
  if (codeAgent) {
    executor.register(createCodeAgentTool(codeAgent))
  }

  // GitHub tools (available if GITHUB_TOKEN is set)
  if (github) {
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
    ])
  }

  // Workflow tool (registered last — it references the executor to call other tools)
  executor.register(createWorkflowTool(executor, builtinWorkflows))

  return executor
}
