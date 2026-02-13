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
  createMemoryTools,
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
  createMemoryTools,
} from './builtin'

/**
 * Create tool executor with all default tools.
 * If MemoryManager is provided, memory tools will be functional.
 * Otherwise, they'll return "not initialized" errors.
 */
export function createDefaultToolExecutor(memory?: MemoryManager) {
  const executor = createToolExecutor()

  // Base tools (always available)
  executor.registerAll([
    readTool,
    writeTool,
    editTool,
    execTool,
    globTool,
    screenshotTool,
  ])

  // Memory tools (functional if MemoryManager provided)
  if (memory) {
    const { memorySearchTool, memoryGetTool, memorySetTool } = createMemoryTools(memory)
    executor.registerAll([memorySearchTool, memoryGetTool, memorySetTool])
  } else {
    // Register stubs that return helpful error messages
    executor.registerAll([memorySearchTool, memoryGetTool])
  }

  return executor
}
