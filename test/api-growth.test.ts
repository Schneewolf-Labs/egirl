import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentLoop } from '../src/agent'
import { type APIConfig, type APIDeps, startAPIServer } from '../src/api'
import { recordMutation } from '../src/skills/ledger'
import { makeConfig } from './agent/helpers'

describe('GET /growth', () => {
  let server: ReturnType<typeof startAPIServer>
  let workspace: string
  let skillsDir: string
  const port = 3893
  const base = `http://127.0.0.1:${port}`

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'egirl-growth-'))
    skillsDir = join(workspace, 'skills')
    mkdirSync(join(skillsDir, 'wine-probe'), { recursive: true })
    writeFileSync(
      join(skillsDir, 'wine-probe/SKILL.md'),
      '---\negirl:\n  origin: agent\n---\n\n# Wine Probe\n\nUse when probing Wine runs: captures screens and stderr.\n\n## When to Use\n\nCaptures.\n\n## Instructions\n\nRun it.',
    )
    writeFileSync(join(workspace, 'MEMORY.md'), '- fact one\n- fact two\n')
    recordMutation(join(workspace, '.skill-ledger'), {
      actor: 'background',
      tool: 'skill_manage',
      path: join(skillsDir, 'wine-probe/SKILL.md'),
      beforeContent: null,
      afterContent: 'x',
    })

    const config = { ...makeConfig(workspace), skills: { dirs: [skillsDir] } }
    const deps: APIDeps = {
      agentFactory: (id) => ({ getContext: () => ({ sessionId: id }) }) as unknown as AgentLoop,
      agents: new Map(),
      config,
    }
    server = startAPIServer({ host: '127.0.0.1', port } as APIConfig, deps)
  })

  afterEach(() => {
    server.stop(true)
  })

  test('reports skills with origin, the ledger, and working-memory budget', async () => {
    const res = await fetch(`${base}/growth`)
    expect(res.status).toBe(200)
    const d = (await res.json()) as {
      skills: Array<{ name: string; origin: string }>
      ledger: Array<{ actor: string; kind: string }>
      working_memory: { entries: number; chars: number; budget: number }
    }
    expect(d.skills).toHaveLength(1)
    expect(d.skills[0]?.origin).toBe('agent')
    expect(d.ledger).toHaveLength(1)
    expect(d.ledger[0]?.actor).toBe('background')
    expect(d.ledger[0]?.kind).toBe('created')
    expect(d.working_memory.entries).toBe(2)
    expect(d.working_memory.budget).toBeGreaterThan(0)
  })
})
