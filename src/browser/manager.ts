import { type Browser, type BrowserContext, chromium, type Page } from 'playwright'
import { log } from '../util/logger'
import { resolveTarget } from './targeting'

/**
 * Validate that a browser expression doesn't perform dangerous operations.
 * Returns a rejection reason or undefined if safe.
 *
 * Blocks: fetch/XMLHttpRequest (exfiltration), cookie/localStorage access,
 * dynamic script creation, navigation, and window.open.
 */
const BLOCKED_BROWSER_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\bfetch\s*\(/,
    reason: 'fetch() calls are not allowed — use web_research tool instead',
  },
  { pattern: /\bXMLHttpRequest\b/, reason: 'XMLHttpRequest is not allowed' },
  { pattern: /\bnew\s+WebSocket\b/, reason: 'WebSocket creation is not allowed' },
  { pattern: /\bdocument\.cookie\b/, reason: 'Cookie access is not allowed' },
  { pattern: /\blocalStorage\b/, reason: 'localStorage access is not allowed' },
  { pattern: /\bsessionStorage\b/, reason: 'sessionStorage access is not allowed' },
  { pattern: /\bindexedDB\b/, reason: 'indexedDB access is not allowed' },
  { pattern: /\bdocument\.write\b/, reason: 'document.write is not allowed' },
  {
    pattern: /\bcreateElement\s*\(\s*['"`]script/,
    reason: 'Dynamic script creation is not allowed',
  },
  { pattern: /\bwindow\.open\s*\(/, reason: 'window.open is not allowed' },
  { pattern: /\blocation\s*[.=]/, reason: 'Navigation via location is not allowed' },
  { pattern: /\bnavigator\.sendBeacon\b/, reason: 'sendBeacon is not allowed' },
  { pattern: /\bimportScripts\b/, reason: 'importScripts is not allowed' },
  { pattern: /\beval\s*\(/, reason: 'eval() inside browser context is not allowed' },
  { pattern: /\bFunction\s*\(/, reason: 'Function constructor is not allowed' },
]

function validateBrowserExpression(expression: string): string | undefined {
  for (const { pattern, reason } of BLOCKED_BROWSER_PATTERNS) {
    if (pattern.test(expression)) {
      return reason
    }
  }
  return undefined
}

export interface BrowserConfig {
  headless?: boolean
  defaultTimeout?: number
}

export interface PageSnapshot {
  url: string
  title: string
  content: string
}

export interface ElementInfo {
  role: string
  name: string
  tag: string
  text: string
  isVisible: boolean
  isEnabled: boolean
}

/**
 * Manages a single browser instance with one active page.
 * Designed for agent use — sequential operations, not parallel tabs.
 */
export class BrowserManager {
  private browser: Browser | undefined
  private context: BrowserContext | undefined
  private page: Page | undefined
  private config: BrowserConfig

  constructor(config: BrowserConfig = {}) {
    this.config = {
      headless: config.headless ?? true,
      defaultTimeout: config.defaultTimeout ?? 30000,
    }
  }

  get isOpen(): boolean {
    return this.browser?.isConnected() ?? false
  }

  private async ensurePage(): Promise<Page> {
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await chromium.launch({ headless: this.config.headless })
      this.context = await this.browser.newContext({
        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      })
      this.page = await this.context.newPage()
      this.page.setDefaultTimeout(this.config.defaultTimeout!)
      log.info('browser', 'Launched browser')
    }

    if (!this.page || this.page.isClosed()) {
      this.page = await this.context?.newPage()
    }

    if (!this.page) {
      throw new Error('Failed to create browser page')
    }

    return this.page
  }

  async navigate(url: string): Promise<PageSnapshot> {
    const page = await this.ensurePage()
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' })

    if (!response) {
      throw new Error(`Navigation to ${url} returned no response`)
    }

    log.info('browser', `Navigated to ${url} (${response.status()})`)
    return this.snapshot()
  }

  async snapshot(): Promise<PageSnapshot> {
    const page = await this.ensurePage()

    const title = await page.title()
    const url = page.url()
    const content = await page.evaluate(() => {
      // Extract visible text content, structured by semantic elements
      function extractText(node: Node, depth: number): string {
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent?.trim()
          return text || ''
        }

        if (node.nodeType !== Node.ELEMENT_NODE) return ''
        const el = node as Element

        // Skip hidden elements
        const style = window.getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden') return ''

        // Skip script/style
        const tag = el.tagName.toLowerCase()
        if (tag === 'script' || tag === 'style' || tag === 'noscript') return ''

        const parts: string[] = []
        for (const child of el.childNodes) {
          const text = extractText(child, depth + 1)
          if (text) parts.push(text)
        }

        const joined = parts.join(' ')
        if (!joined) return ''

        // Add structure hints for key elements
        const role = el.getAttribute('role')
        const ariaLabel = el.getAttribute('aria-label')

        if (tag === 'a') return `[link: ${ariaLabel || joined}]`
        if (tag === 'button' || role === 'button') return `[button: ${ariaLabel || joined}]`
        if (tag === 'input' || tag === 'textarea') {
          const inputEl = el as HTMLInputElement
          const label = ariaLabel || el.getAttribute('placeholder') || inputEl.name
          return `[${inputEl.type || 'input'}: ${label}]`
        }
        if (tag === 'select') return `[select: ${ariaLabel || joined}]`
        if (tag === 'img') return `[image: ${ariaLabel || el.getAttribute('alt') || ''}]`
        if (/^h[1-6]$/.test(tag)) return `\n## ${joined}\n`
        if (tag === 'li') return `- ${joined}`
        if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article') {
          return `${joined}\n`
        }

        return joined
      }

      return extractText(document.body, 0)
    })

    // Collapse excessive whitespace
    const cleaned = content
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()

    // Truncate if very long
    const maxLength = 50000
    const truncated =
      cleaned.length > maxLength
        ? `${cleaned.slice(0, maxLength)}\n\n[Truncated — content exceeded ${maxLength} characters]`
        : cleaned

    return { url, title, content: truncated }
  }

  async click(target: string): Promise<PageSnapshot> {
    const page = await this.ensurePage()
    const locator = resolveTarget(page, target)
    await locator.click()
    await page.waitForLoadState('domcontentloaded').catch(() => {})
    return this.snapshot()
  }

  async fill(target: string, value: string): Promise<PageSnapshot> {
    const page = await this.ensurePage()
    const locator = resolveTarget(page, target)
    await locator.fill(value)
    return this.snapshot()
  }

  async selectOption(target: string, value: string): Promise<PageSnapshot> {
    const page = await this.ensurePage()
    const locator = resolveTarget(page, target)
    await locator.selectOption(value)
    return this.snapshot()
  }

  async check(target: string): Promise<PageSnapshot> {
    const page = await this.ensurePage()
    const locator = resolveTarget(page, target)
    await locator.check()
    return this.snapshot()
  }

  async uncheck(target: string): Promise<PageSnapshot> {
    const page = await this.ensurePage()
    const locator = resolveTarget(page, target)
    await locator.uncheck()
    return this.snapshot()
  }

  async hover(target: string): Promise<PageSnapshot> {
    const page = await this.ensurePage()
    const locator = resolveTarget(page, target)
    await locator.hover()
    return this.snapshot()
  }

  async waitFor(target: string, timeout?: number): Promise<PageSnapshot> {
    const page = await this.ensurePage()
    const locator = resolveTarget(page, target)
    await locator.waitFor({
      state: 'visible',
      timeout: timeout ?? this.config.defaultTimeout,
    })
    return this.snapshot()
  }

  async screenshot(): Promise<string> {
    const page = await this.ensurePage()
    const buffer = await page.screenshot({ fullPage: false, type: 'png' })
    return `data:image/png;base64,${buffer.toString('base64')}`
  }

  async evaluate(expression: string): Promise<unknown> {
    const blocked = validateBrowserExpression(expression)
    if (blocked) {
      throw new Error(`Expression blocked: ${blocked}`)
    }

    const page = await this.ensurePage()
    return page.evaluate(expression)
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close()
      this.browser = undefined
      this.context = undefined
      this.page = undefined
      log.info('browser', 'Closed browser')
    }
  }
}
