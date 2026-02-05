export * from './types'
export { ToolExecutor, createToolExecutor } from './executor'
export {
  readTool,
  writeTool,
  editTool,
  execTool,
  globTool,
  memorySearchTool,
  memoryGetTool,
} from './builtin'

import { createToolExecutor } from './executor'
import {
  readTool,
  writeTool,
  editTool,
  execTool,
  globTool,
  memorySearchTool,
  memoryGetTool,
} from './builtin'

export function createDefaultToolExecutor() {
  const executor = createToolExecutor()
  executor.registerAll([
    readTool,
    writeTool,
    editTool,
    execTool,
    globTool,
    memorySearchTool,
    memoryGetTool,
  ])
  return executor
}
