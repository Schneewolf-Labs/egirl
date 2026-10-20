import type { ToolDefinition } from '../providers/types'

/**
 * The "Available Tools" section of the system prompt, built from the tools the model is actually
 * handed. It used to be one hardcoded block that listed exec, git and code_agent on every
 * instance, including ones where those tools were turned off, so a locked-down instance (a public
 * API, a research-only agent) was told about tools it could not call and kept trying them.
 *
 * Tools with curated guidance below get that line; any other registered tool (MCP, task tools, a
 * newly added builtin) is listed with the first sentence of its own description, so a new tool
 * can never be silently missing from the prompt.
 */

interface ToolGroup {
  title: string
  lines: Record<string, string>
}

const GROUPS: ToolGroup[] = [
  {
    title: 'Files',
    lines: {
      read_file: 'Read file contents (supports line ranges)',
      write_file: 'Write content to a file (creates directories)',
      edit_file: 'Edit a file with exact string replacement',
      glob_files: 'Find files matching a glob pattern',
    },
  },
  {
    title: 'System',
    lines: {
      execute_command: 'Run shell commands',
      screenshot: 'Capture a screenshot of the current display',
    },
  },
  {
    title: 'Git',
    lines: {
      git_status: 'Show repository state (branch, staged/unstaged/untracked)',
      git_diff: 'Show diffs (staged, unstaged, or between refs)',
      git_log: 'Show commit history',
      git_commit: 'Stage files and create a commit',
      git_show: "Show a specific commit's contents and diff",
      git_pr_state:
        'Where a PR branch stands against main: merge base, conflicts from a real trial merge, files main also changed, patches already on main. Use it first when reviewing a PR',
    },
  },
  {
    title: 'Memory',
    lines: {
      working_memory:
        'Curate MEMORY.md, your always-loaded working memory (add/replace/remove/list under a hard character budget — when full, consolidate before adding)',
      memory_search: 'Search memories (hybrid keyword + semantic, with category and time filters)',
      memory_get: 'Retrieve a specific memory by key',
      memory_set:
        'Store a memory with optional category (fact, preference, decision, project, entity)',
      memory_delete: 'Delete a memory by key',
      memory_list: 'List stored memories (filterable by category and source)',
      memory_recall: 'Recall memories from a time period ("last week", "3 days ago", etc.)',
    },
  },
  {
    title: 'Web',
    lines: {
      web_search:
        'Search the web; returns titles, URLs and snippets. Use it whenever the answer depends on anything after your training data or anything that changes — releases, versions, prices, news, "latest", "current", "today". Search and answer from the results; do not answer from memory and then offer to check.',
      web_research: 'Fetch a URL and return its text content',
    },
  },
  {
    title: 'Math',
    lines: {
      calculate:
        'Evaluate arithmetic exactly (percentages, unit conversions, compound growth, multi-step sums). Use it for anything beyond trivial mental math instead of computing in your head, and answer from its result.',
    },
  },
  {
    title: 'Skills',
    lines: {
      skill_manage:
        'Create, patch, or archive a skill (SKILL.md). When you develop a reusable procedure, save it as a skill; prefer patching an existing skill you used over creating a near-duplicate.',
    },
  },
  {
    title: 'Delegation (primary)',
    lines: {
      code_agent:
        'Delegate coding work to the configured code agent (multi-file edits, refactoring, debugging, test writing, reading unfamiliar code). This is your main tool for project work. Refer to this as "the code agent" when talking to the user — never say "code_agent".',
      consult:
        'Ask a configured consultant model (much larger context window) for a read-only second opinion. Attach whole files; use it when stuck or before committing to a direction.',
    },
  },
]

const CURATED = new Set(GROUPS.flatMap((g) => Object.keys(g.lines)))

const FILE_TOOLS = ['read_file', 'write_file', 'edit_file', 'glob_files']
const GIT_TOOLS = Object.keys(GROUPS.find((g) => g.title === 'Git')?.lines ?? {})

/** First sentence of a tool's own description, for tools without a curated line. */
function shortDescription(description: string): string {
  const text = description.replace(/\s+/g, ' ').trim()
  const end = text.search(/\.(\s|$)/)
  const sentence = end === -1 ? text : text.slice(0, end + 1)
  return sentence.length > 200 ? `${sentence.slice(0, 197)}...` : sentence
}

/** The tools section for these definitions, or '' when there are none. */
export function buildToolsSection(workspaceDir: string, tools: ToolDefinition[]): string {
  if (tools.length === 0) return ''
  const names = new Set(tools.map((t) => t.name))
  const has = (name: string): boolean => names.has(name)
  const parts: string[] = ['## Available Tools']

  if (FILE_TOOLS.some(has) || has('execute_command')) {
    parts.push(
      `Your workspace directory is \`${workspaceDir}\`. All relative file paths are resolved against this directory — not the user's shell cwd. When you write or read files with relative paths, they go in the workspace. Use absolute paths when working outside of it.`,
    )
  }

  const blocks: string[] = []
  for (const group of GROUPS) {
    const lines = Object.entries(group.lines)
      .filter(([name]) => has(name))
      .map(([name, line]) => `- \`${name}\` - ${line}`)
    if (lines.length > 0) blocks.push(`**${group.title}:**\n${lines.join('\n')}`)
  }
  const others = tools
    .filter((t) => !CURATED.has(t.name))
    .map((t) => `- \`${t.name}\` - ${shortDescription(t.description)}`)
  if (others.length > 0) blocks.push(`**Other:**\n${others.join('\n')}`)
  parts.push(`You have access to these tools:\n\n${blocks.join('\n\n')}`)

  const usage = ['Use tools proactively to gather information rather than asking.']
  if (GIT_TOOLS.some(has) && has('execute_command')) {
    usage.push('Use git tools directly instead of running git via execute_command.')
  }
  if (has('code_agent')) {
    usage.push(
      "**Delegate coding work to the code agent by default — you're the human-in-the-loop, not a code generator.**",
    )
    if (has('edit_file')) {
      usage.push(
        "Only use edit_file directly for trivial single-line changes you're certain about.",
      )
    }
  }
  parts.push(usage.join(' '))
  parts.push(
    '**Important:** When you decide to use a tool, call it immediately in the same response — do not narrate your intention first. Never say "I\'ll use X tool" or "Let me run Y" and then stop. Just call the tool.',
  )

  return parts.join('\n\n')
}
