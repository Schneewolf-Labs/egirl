/**
 * Energy costs for tool execution.
 *
 * Inspired by Hexis: costs are scored by situational impact
 * (irreversibility, social exposure, commitment) rather than
 * computational expense. The system sets costs, not the agent.
 */

export interface EnergyCost {
  /** Base energy cost for this tool */
  cost: number
  /** Whether this tool is read-only (no side effects) */
  isReadOnly: boolean
}

/**
 * Default energy costs per tool, grouped by impact level.
 *
 * Read/observe: 0.5
 * Search/query: 0.5-1.0
 * Create/draft: 1.0-2.0
 * Modify/write: 2.0-3.0
 * Execute/shell: 3.0-5.0
 * External/social: 5.0-8.0
 * Destructive: 5.0-7.0
 */
const TOOL_COSTS: Record<string, EnergyCost> = {
  // Read-only / observe — cheap
  read_file: { cost: 0.5, isReadOnly: true },
  glob_files: { cost: 0.5, isReadOnly: true },
  git_status: { cost: 0.5, isReadOnly: true },
  git_diff: { cost: 0.5, isReadOnly: true },
  git_log: { cost: 0.5, isReadOnly: true },
  git_show: { cost: 0.5, isReadOnly: true },
  memory_search: { cost: 0.5, isReadOnly: true },
  memory_get: { cost: 0.5, isReadOnly: true },
  memory_list: { cost: 0.5, isReadOnly: true },
  memory_recall: { cost: 0.5, isReadOnly: true },
  screenshot: { cost: 0.5, isReadOnly: true },
  browser_snapshot: { cost: 0.5, isReadOnly: true },
  browser_screenshot: { cost: 0.5, isReadOnly: true },

  // Search / query — still cheap
  web_research: { cost: 1.0, isReadOnly: true },
  gh_pr_list: { cost: 0.5, isReadOnly: true },
  gh_pr_view: { cost: 0.5, isReadOnly: true },
  gh_issue_list: { cost: 0.5, isReadOnly: true },
  gh_issue_view: { cost: 0.5, isReadOnly: true },
  gh_ci_status: { cost: 0.5, isReadOnly: true },
  gh_release_list: { cost: 0.5, isReadOnly: true },
  task_list: { cost: 0.5, isReadOnly: true },
  task_history: { cost: 0.5, isReadOnly: true },

  // Create / draft — moderate
  memory_set: { cost: 1.0, isReadOnly: false },
  memory_delete: { cost: 1.5, isReadOnly: false },
  browser_navigate: { cost: 1.0, isReadOnly: false },
  browser_click: { cost: 1.0, isReadOnly: false },
  browser_fill: { cost: 1.0, isReadOnly: false },
  browser_select: { cost: 1.0, isReadOnly: false },
  browser_check: { cost: 1.0, isReadOnly: false },
  browser_hover: { cost: 0.5, isReadOnly: false },
  browser_wait: { cost: 0.5, isReadOnly: true },
  browser_eval: { cost: 2.0, isReadOnly: false },
  browser_close: { cost: 0.5, isReadOnly: false },
  task_add: { cost: 1.5, isReadOnly: false },
  task_pause: { cost: 1.0, isReadOnly: false },
  task_resume: { cost: 1.0, isReadOnly: false },

  // Modify / write — higher cost, side effects
  write_file: { cost: 2.5, isReadOnly: false },
  edit_file: { cost: 2.0, isReadOnly: false },
  git_commit: { cost: 3.0, isReadOnly: false },
  gh_branch_create: { cost: 2.0, isReadOnly: false },

  // Execute / shell — high cost, unpredictable
  execute_command: { cost: 4.0, isReadOnly: false },
  code_agent: { cost: 5.0, isReadOnly: false },
  task_run: { cost: 3.0, isReadOnly: false },
  task_cancel: { cost: 2.0, isReadOnly: false },
  run_workflow: { cost: 4.0, isReadOnly: false },

  // External / social — highest cost (visible to others)
  gh_pr_create: { cost: 6.0, isReadOnly: false },
  gh_pr_review: { cost: 5.0, isReadOnly: false },
  gh_pr_comment: { cost: 5.0, isReadOnly: false },
  gh_issue_comment: { cost: 5.0, isReadOnly: false },
  gh_issue_update: { cost: 4.0, isReadOnly: false },
}

/** Default cost for unknown tools */
const DEFAULT_COST: EnergyCost = { cost: 2.0, isReadOnly: false }

/** Get the energy cost for a tool by name */
export function getToolCost(toolName: string): EnergyCost {
  return TOOL_COSTS[toolName] ?? DEFAULT_COST
}

/** Check if a tool is known to the cost system */
export function hasToolCost(toolName: string): boolean {
  return toolName in TOOL_COSTS
}
