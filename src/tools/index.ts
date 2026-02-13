export * from './types'
export * from './format'
export { ToolExecutor, createToolExecutor } from './executor'
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
} from './builtin'

/**
 * Create tool executor with all default tools.
 * If MemoryManager is provided, memory tools will be functional.
 * If CodeAgentConfig is provided, the code_agent tool will be available.
 */
export function createDefaultToolExecutor(memory?: MemoryManager, codeAgent?: CodeAgentConfig) {
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
  ])

  // Memory tools (functional if MemoryManager provided)
  if (memory) {
    const { memorySearchTool, memoryGetTool, memorySetTool } = createMemoryTools(memory)
    executor.registerAll([memorySearchTool, memoryGetTool, memorySetTool])
  } else {
    // Register stubs that return helpful error messages
    executor.registerAll([memorySearchTool, memoryGetTool])
  }

  // Code agent tool (available if claude code config provided)
  if (codeAgent) {
    executor.register(createCodeAgentTool(codeAgent))
  }

  return executor
}
