import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCodeAgentTool } from '../../src/tools/builtin/code-agent'
import { withImagePaths } from '../../src/tools/builtin/code-agent/shared'

describe('code_agent images', () => {
  test('an image it cannot find fails before any agent starts', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'egirl-ca-'))
    const tool = createCodeAgentTool({ permissionMode: 'default', workingDir: ws })
    const result = await tool.execute({ task: 'match the mockup', images: ['img3'] }, ws, {
      sessionId: 's',
    })
    expect(result.success).toBe(false)
    expect(result.output).toContain('img3')
  })

  test('a working_dir that does not exist fails before any agent starts, naming it', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'egirl-ca-'))
    const tool = createCodeAgentTool({ permissionMode: 'default', workingDir: ws })
    const missing = join(ws, 'no-such-project')
    const result = await tool.execute({ task: 'draw a bat', working_dir: missing }, ws, {
      sessionId: 's',
    })
    expect(result.success).toBe(false)
    expect(result.output).toContain(`working_dir does not exist: ${missing}`)
    expect(result.output).toContain(ws)
  })

  test('text-prompt backends get the image paths listed under the task', () => {
    expect(withImagePaths('fix it', undefined)).toBe('fix it')
    const out = withImagePaths('fix it', ['/w/a.png', '/w/b.png'])
    expect(out).toStartWith('fix it\n\n')
    expect(out).toContain('- /w/a.png\n- /w/b.png')
  })
})
