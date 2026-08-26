import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { recordMutation } from '../../skills/ledger'
import { formatLintFindings, lintSkill } from '../../skills/linter'
import { extractSkillDescription, extractSkillName, parseSkillMarkdown } from '../../skills/parser'
import type { Tool, ToolResult } from '../types'

/**
 * skill_manage — structured, guarded mutations to SKILL.md files. Ported from hermes-agent's
 * skill_manager_tool: the piece that makes skill editing safe enough to hand to an
 * autonomous actor. Guards, in order: names are validated; a patch must match uniquely
 * (whitespace-tolerant, so a re-quoted transcript still lands); every write is linted and an
 * ERROR-level finding ROLLS THE WRITE BACK; skills are archived, never deleted; created
 * skills carry origin: agent provenance; and every mutation lands in the skill ledger.
 */

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/
const MAX_SKILL_CHARS = 24000
const ARCHIVE_DIR = '.archive'

export interface SkillManageOptions {
  /**
   * "background" restricts mutations to skills whose frontmatter says origin: agent — an
   * autonomous pass may evolve what agents authored, but the user's own skills are theirs.
   */
  actor: 'agent' | 'background'
}

/** Whitespace-tolerant unique match: exact first, then line-trimmed comparison. */
export function findPatchTarget(
  content: string,
  oldText: string,
): { start: number; end: number } | { error: string } {
  const direct = content.indexOf(oldText)
  if (direct !== -1) {
    if (content.indexOf(oldText, direct + 1) !== -1) {
      return { error: 'old_text matches more than once — include more surrounding context' }
    }
    return { start: direct, end: direct + oldText.length }
  }
  // Tolerant pass: compare with per-line trimmed whitespace, then map back to raw offsets.
  const normalize = (s: string) =>
    s
      .split('\n')
      .map((l) => l.trim())
      .join('\n')
  const target = normalize(oldText)
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const span = oldText.split('\n').length
    const candidate = lines.slice(i, i + span).join('\n')
    if (normalize(candidate) === target) {
      const start = lines.slice(0, i).join('\n').length + (i > 0 ? 1 : 0)
      return { start, end: start + candidate.length }
    }
  }
  return {
    error: 'old_text not found in the skill — read it with skill_read and retry with exact text',
  }
}

function skillPath(dir: string, name: string): string {
  return join(dir, name, 'SKILL.md')
}

/** Locate an existing skill by name across the configured dirs. */
function findSkill(dirs: string[], name: string): string | undefined {
  for (const dir of dirs) {
    const p = skillPath(dir, name)
    if (existsSync(p)) return p
  }
  return undefined
}

function isAgentOwned(content: string): boolean {
  const parsed = parseSkillMarkdown(content)
  const meta = parsed.metadata as { egirl?: { origin?: string } }
  return meta.egirl?.origin === 'agent'
}

/** Lint the post-write state; ERROR findings are blocking. */
function lintContent(
  name: string,
  baseDir: string,
  raw: string,
): { errors: string; warnings: string } {
  const parsed = parseSkillMarkdown(raw)
  const findings = lintSkill({
    name: extractSkillName(parsed.content) || name,
    description: extractSkillDescription(parsed.content),
    content: parsed.content,
    metadata: parsed.metadata,
    baseDir,
    enabled: true,
  })
  return {
    errors: formatLintFindings(
      name,
      findings.filter((f) => f.level === 'error'),
    ),
    warnings: formatLintFindings(
      name,
      findings.filter((f) => f.level === 'warning'),
    ),
  }
}

export function createSkillManageTool(
  skillsDirs: string[],
  ledgerDir: string,
  options: SkillManageOptions = { actor: 'agent' },
): Tool {
  const authoringDir = skillsDirs[0]

  return {
    definition: {
      name: 'skill_manage',
      description:
        'Create, patch, or archive a skill (SKILL.md). ' +
        '"create" writes a new skill (kebab-case name for the CLASS of task, never a session artifact). ' +
        '"patch" does targeted find-and-replace inside an existing skill — old_text must match exactly once; read the skill first with skill_read. ' +
        '"archive" retires a skill without deleting it. ' +
        'Prefer patching an existing skill you actually used over creating a near-duplicate. Every write is linted; structural errors roll the write back.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: '"create", "patch", or "archive"' },
          name: { type: 'string', description: 'Skill name (kebab-case, matches its directory)' },
          content: {
            type: 'string',
            description:
              'create: full SKILL.md body — a "# Title", one description paragraph under it saying what it does and WHEN to use it, "## When to Use", "## Instructions"',
          },
          old_text: {
            type: 'string',
            description: 'patch: exact text to replace (must match once)',
          },
          new_text: { type: 'string', description: 'patch: replacement text' },
        },
        required: ['action', 'name'],
      },
    },

    async execute(params: Record<string, unknown>): Promise<ToolResult> {
      const action = params.action as string | undefined
      const name = (params.name as string | undefined)?.trim() ?? ''
      if (!NAME_RE.test(name)) {
        return {
          success: false,
          output: `Invalid skill name "${name}" — lowercase kebab-case (a-z, 0-9, hyphens), naming the class of task.`,
        }
      }
      if (!authoringDir) {
        return { success: false, output: 'No skills directory is configured.' }
      }

      if (action === 'create') {
        const content = params.content as string | undefined
        if (!content?.trim()) return { success: false, output: 'create requires content' }
        if (findSkill(skillsDirs, name)) {
          return {
            success: false,
            output: `Skill "${name}" already exists — use action "patch" to improve it instead of creating a duplicate.`,
          }
        }
        if (content.length > MAX_SKILL_CHARS) {
          return {
            success: false,
            output: `Skill body is ${content.length} chars (max ${MAX_SKILL_CHARS}). Move deep detail into your notes and keep the skill to the reusable procedure.`,
          }
        }
        // Provenance frontmatter: created-by-agent skills are the only ones an autonomous
        // pass may later evolve. Prepended even when the author supplied frontmatter-less
        // content; supplied frontmatter is preserved by merging above it being complex —
        // instead we require frontmatter-less content and stamp our own.
        const body = content.startsWith('---')
          ? content
          : `---\nmetadata:\n  egirl:\n    origin: agent\n---\n\n${content.trim()}\n`

        const lint = lintContent(name, join(authoringDir, name), body)
        if (lint.errors) {
          return { success: false, output: `Not written — fix these first:\n${lint.errors}` }
        }
        const path = skillPath(authoringDir, name)
        mkdirSync(join(authoringDir, name), { recursive: true })
        writeFileSync(path, body, 'utf8')
        recordMutation(ledgerDir, {
          actor: options.actor,
          tool: 'skill_manage',
          path,
          beforeContent: null,
          afterContent: body,
        })
        const note = lint.warnings ? `\n${lint.warnings}` : ''
        return {
          success: true,
          output: `Created skill "${name}" at ${path}. It loads on the next restart.${note}`,
        }
      }

      if (action === 'patch') {
        const oldText = params.old_text as string | undefined
        const newText = params.new_text as string | undefined
        if (!oldText || newText === undefined) {
          return { success: false, output: 'patch requires old_text and new_text' }
        }
        const path = findSkill(skillsDirs, name)
        if (!path) return { success: false, output: `Skill "${name}" not found.` }
        const before = readFileSync(path, 'utf8')
        if (options.actor === 'background' && !isAgentOwned(before)) {
          return {
            success: false,
            output: `Skill "${name}" is not agent-created — the autonomous pass may not modify it. Note the suggested improvement in memory instead.`,
          }
        }
        const target = findPatchTarget(before, oldText)
        if ('error' in target) return { success: false, output: target.error }
        const after = before.slice(0, target.start) + newText + before.slice(target.end)
        if (after.length > MAX_SKILL_CHARS) {
          return {
            success: false,
            output: `Patched skill would be ${after.length} chars (max ${MAX_SKILL_CHARS}).`,
          }
        }
        const lint = lintContent(name, join(path, '..'), after)
        if (lint.errors) {
          // The write is validated before it happens, so "roll back" is simply not writing.
          return {
            success: false,
            output: `Patch rejected — it would break the skill:\n${lint.errors}`,
          }
        }
        writeFileSync(path, after, 'utf8')
        recordMutation(ledgerDir, {
          actor: options.actor,
          tool: 'skill_manage',
          path,
          beforeContent: before,
          afterContent: after,
        })
        const note = lint.warnings ? `\n${lint.warnings}` : ''
        return { success: true, output: `Patched skill "${name}". Reloads on next restart.${note}` }
      }

      if (action === 'archive') {
        const path = findSkill(skillsDirs, name)
        if (!path) return { success: false, output: `Skill "${name}" not found.` }
        const before = readFileSync(path, 'utf8')
        if (options.actor === 'background' && !isAgentOwned(before)) {
          return {
            success: false,
            output: `Skill "${name}" is not agent-created — the autonomous pass may not archive it.`,
          }
        }
        const skillDir = join(path, '..')
        const archiveRoot = join(skillDir, '..', ARCHIVE_DIR)
        mkdirSync(archiveRoot, { recursive: true })
        const dest = join(archiveRoot, name)
        if (existsSync(dest)) {
          return { success: false, output: `An archived skill named "${name}" already exists.` }
        }
        renameSync(skillDir, dest)
        recordMutation(ledgerDir, {
          actor: options.actor,
          tool: 'skill_manage',
          path,
          beforeContent: before,
          afterContent: null,
        })
        return {
          success: true,
          output: `Archived skill "${name}" to ${dest} (recoverable — nothing is hard-deleted).`,
        }
      }

      return { success: false, output: 'action must be "create", "patch", or "archive"' }
    },
  }
}
