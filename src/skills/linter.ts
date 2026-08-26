import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Skill } from './types'

/**
 * Skill linter — ported from hermes-agent's skill_linter rules. A skill's name and
 * description are its routing signal: the index shows them truncated, so a vague or
 * marketing-flavored description means the skill never gets picked when it should.
 * Findings are advisory (warnings in the log, feedback text for the authoring flow);
 * nothing is blocked.
 */

export interface LintFinding {
  level: 'error' | 'warning'
  message: string
}

/** Descriptions get truncated in listings around here — signal beyond it is lost. */
const DESCRIPTION_SIGNAL_CHARS = 200

const MARKETING_WORDS =
  /\b(powerful|seamless|cutting-edge|revolutionary|best-in-class|state-of-the-art|effortless|supercharge|blazing)\b/i

// egirl skill names are their H1 titles ("Wine Probe Capture"), so words and spaces are the
// convention; only genuinely weird characters are an error.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]*$/

export function lintSkill(skill: Skill): LintFinding[] {
  const findings: LintFinding[] = []

  if (!NAME_RE.test(skill.name)) {
    findings.push({
      level: 'error',
      message: `name "${skill.name}" contains unusual characters — words, digits, spaces, and hyphens only`,
    })
  }

  if (!skill.description?.trim()) {
    findings.push({
      level: 'error',
      message: 'missing description — the skill can never be routed to without one',
    })
  } else {
    if (skill.description.length > DESCRIPTION_SIGNAL_CHARS) {
      findings.push({
        level: 'warning',
        message: `description is ${skill.description.length} chars; listings truncate around ${DESCRIPTION_SIGNAL_CHARS} — front-load what the skill does and when to use it`,
      })
    }
    if (MARKETING_WORDS.test(skill.description)) {
      findings.push({
        level: 'warning',
        message:
          'description contains marketing language — say what it does and when to use it, not how great it is',
      })
    }
    if (!/\b(use|when|for)\b/i.test(skill.description)) {
      findings.push({
        level: 'warning',
        message:
          'description never says WHEN to use the skill — routing needs a trigger condition, not just a summary',
      })
    }
  }

  // Session-artifact names: a skill must be class-level, not named after today's task.
  if (/\b(today|now|current|latest|temp|tmp|v2|new|fix)\b/i.test(skill.name)) {
    findings.push({
      level: 'warning',
      message: `name "${skill.name}" looks like a session artifact — name skills after the CLASS of task ("wine-probe-capture"), never the instance ("fix-ddraw-today")`,
    })
  }

  // Dangling relative links: a reference the body promises but the directory lacks.
  const linkRe = /\]\((?!https?:|#|mailto:)([^)]+)\)/g
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(skill.content)) !== null) {
    const target = (m[1] as string).split('#')[0]?.trim()
    if (!target) continue
    if (!existsSync(join(skill.baseDir, target))) {
      findings.push({
        level: 'warning',
        message: `dangling link: ${target} does not exist in the skill directory`,
      })
    }
  }

  return findings
}

/** Render findings as a short block for logs or authoring feedback. Empty string when clean. */
export function formatLintFindings(skillName: string, findings: LintFinding[]): string {
  if (findings.length === 0) return ''
  const lines = findings.map((f) => `  [${f.level}] ${f.message}`)
  return `Skill "${skillName}" lint:\n${lines.join('\n')}`
}
