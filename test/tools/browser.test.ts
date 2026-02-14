import { describe, expect, test } from 'bun:test'
import { BrowserManager } from '../../src/browser'
import { createBrowserTools } from '../../src/tools/builtin/browser'

describe('browser tools', () => {
  // Use a fresh manager for structure tests — no browser is launched
  // because we only test definitions, not execution
  const manager = new BrowserManager()
  const tools = createBrowserTools(manager)

  describe('tool definitions', () => {
    test('browser_navigate has correct definition', () => {
      const def = tools.browserNavigateTool.definition
      expect(def.name).toBe('browser_navigate')
      expect(def.parameters.required).toEqual(['url'])
      expect(def.parameters.properties.url).toBeDefined()
    })

    test('browser_click has correct definition', () => {
      const def = tools.browserClickTool.definition
      expect(def.name).toBe('browser_click')
      expect(def.parameters.required).toEqual(['target'])
      expect(def.parameters.properties.target).toBeDefined()
    })

    test('browser_fill has correct definition', () => {
      const def = tools.browserFillTool.definition
      expect(def.name).toBe('browser_fill')
      expect(def.parameters.required).toEqual(['target', 'value'])
      expect(def.parameters.properties.target).toBeDefined()
      expect(def.parameters.properties.value).toBeDefined()
    })

    test('browser_snapshot has correct definition', () => {
      const def = tools.browserSnapshotTool.definition
      expect(def.name).toBe('browser_snapshot')
    })

    test('browser_screenshot has correct definition', () => {
      const def = tools.browserScreenshotTool.definition
      expect(def.name).toBe('browser_screenshot')
    })

    test('browser_select has correct definition', () => {
      const def = tools.browserSelectTool.definition
      expect(def.name).toBe('browser_select')
      expect(def.parameters.required).toEqual(['target', 'value'])
    })

    test('browser_check has correct definition', () => {
      const def = tools.browserCheckTool.definition
      expect(def.name).toBe('browser_check')
      expect(def.parameters.required).toEqual(['target'])
      expect(def.parameters.properties.checked).toBeDefined()
    })

    test('browser_hover has correct definition', () => {
      const def = tools.browserHoverTool.definition
      expect(def.name).toBe('browser_hover')
      expect(def.parameters.required).toEqual(['target'])
    })

    test('browser_wait has correct definition', () => {
      const def = tools.browserWaitTool.definition
      expect(def.name).toBe('browser_wait')
      expect(def.parameters.required).toEqual(['target'])
      expect(def.parameters.properties.timeout).toBeDefined()
    })

    test('browser_eval has correct definition', () => {
      const def = tools.browserEvalTool.definition
      expect(def.name).toBe('browser_eval')
      expect(def.parameters.required).toEqual(['expression'])
    })

    test('browser_close has correct definition', () => {
      const def = tools.browserCloseTool.definition
      expect(def.name).toBe('browser_close')
    })

    test('all tools have descriptions mentioning accessibility or their purpose', () => {
      const allTools = Object.values(tools)
      for (const tool of allTools) {
        expect(tool.definition.description).toBeTruthy()
        expect(tool.definition.description.length).toBeGreaterThan(10)
      }
    })
  })

  describe('input validation', () => {
    test('navigate rejects non-http URLs', async () => {
      const result = await tools.browserNavigateTool.execute({ url: 'ftp://example.com' }, '/tmp')
      expect(result.success).toBe(false)
      expect(result.output).toContain('http')
    })

    test('navigate rejects URLs without protocol', async () => {
      const result = await tools.browserNavigateTool.execute({ url: 'example.com' }, '/tmp')
      expect(result.success).toBe(false)
      expect(result.output).toContain('http')
    })
  })

  describe('error handling', () => {
    // These tests verify tools return ToolResult with success: false
    // instead of throwing when Playwright is not available

    test('navigate handles missing browser gracefully', async () => {
      const result = await tools.browserNavigateTool.execute(
        { url: 'http://localhost:99999' },
        '/tmp',
      )
      expect(result.success).toBe(false)
      expect(result.output).toBeTruthy()
    })

    test('snapshot handles no page gracefully', async () => {
      const freshManager = new BrowserManager()
      const freshTools = createBrowserTools(freshManager)
      const result = await freshTools.browserSnapshotTool.execute({}, '/tmp')
      expect(result.success).toBe(false)
      expect(result.output).toBeTruthy()
    })

    test('click handles no page gracefully', async () => {
      const freshManager = new BrowserManager()
      const freshTools = createBrowserTools(freshManager)
      const result = await freshTools.browserClickTool.execute({ target: 'button/Submit' }, '/tmp')
      expect(result.success).toBe(false)
      expect(result.output).toBeTruthy()
    })

    test('close always succeeds even without open browser', async () => {
      const freshManager = new BrowserManager()
      const freshTools = createBrowserTools(freshManager)
      const result = await freshTools.browserCloseTool.execute({}, '/tmp')
      expect(result.success).toBe(true)
    })
  })
})
