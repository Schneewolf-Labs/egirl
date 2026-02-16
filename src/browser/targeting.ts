import type { Locator, Page } from 'playwright'

/**
 * ARIA role string accepted by Playwright's getByRole().
 * Kept in sync with VALID_ROLES below.
 */
type AriaRole = Parameters<Page['getByRole']>[0]

/**
 * ARIA roles recognized by Playwright's getByRole().
 * Subset of WAI-ARIA roles that are most useful for automation.
 */
const VALID_ROLES = new Set([
  'alert',
  'alertdialog',
  'application',
  'article',
  'banner',
  'blockquote',
  'button',
  'caption',
  'cell',
  'checkbox',
  'code',
  'columnheader',
  'combobox',
  'complementary',
  'contentinfo',
  'definition',
  'deletion',
  'dialog',
  'directory',
  'document',
  'emphasis',
  'feed',
  'figure',
  'form',
  'generic',
  'grid',
  'gridcell',
  'group',
  'heading',
  'img',
  'insertion',
  'link',
  'list',
  'listbox',
  'listitem',
  'log',
  'main',
  'marquee',
  'math',
  'menu',
  'menubar',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'meter',
  'navigation',
  'none',
  'note',
  'option',
  'paragraph',
  'presentation',
  'progressbar',
  'radio',
  'radiogroup',
  'region',
  'row',
  'rowgroup',
  'rowheader',
  'scrollbar',
  'search',
  'searchbox',
  'separator',
  'slider',
  'spinbutton',
  'status',
  'strong',
  'subscript',
  'superscript',
  'switch',
  'tab',
  'table',
  'tablist',
  'tabpanel',
  'term',
  'textbox',
  'time',
  'timer',
  'toolbar',
  'tooltip',
  'tree',
  'treegrid',
  'treeitem',
])

export interface TargetRef {
  strategy: 'role' | 'text' | 'label' | 'placeholder' | 'testid' | 'title' | 'css'
  role?: string
  name?: string
  value: string
}

/**
 * Parse an element target reference string into a structured TargetRef.
 *
 * Supported formats:
 *   "button/Submit"            → getByRole('button', { name: 'Submit' })
 *   "link/Home"                → getByRole('link', { name: 'Home' })
 *   "heading/Welcome"          → getByRole('heading', { name: 'Welcome' })
 *   "textbox/Email"            → getByRole('textbox', { name: 'Email' })
 *   "text:Welcome back"        → getByText('Welcome back')
 *   "label:Email address"      → getByLabel('Email address')
 *   "placeholder:Search..."    → getByPlaceholder('Search...')
 *   "testid:submit-btn"        → getByTestId('submit-btn')
 *   "title:Close dialog"       → getByTitle('Close dialog')
 *   "css:#submit"              → page.locator('#submit') (escape hatch)
 */
export function parseTarget(ref: string): TargetRef {
  // Strategy prefix formats: "strategy:value"
  const colonIdx = ref.indexOf(':')
  if (colonIdx > 0) {
    const prefix = ref.slice(0, colonIdx).toLowerCase()
    const value = ref.slice(colonIdx + 1)

    if (!value) {
      throw new Error(`Empty value in target ref: "${ref}"`)
    }

    switch (prefix) {
      case 'text':
        return { strategy: 'text', value }
      case 'label':
        return { strategy: 'label', value }
      case 'placeholder':
        return { strategy: 'placeholder', value }
      case 'testid':
        return { strategy: 'testid', value }
      case 'title':
        return { strategy: 'title', value }
      case 'css':
        return { strategy: 'css', value }
    }
  }

  // Role/name format: "role/name"
  const slashIdx = ref.indexOf('/')
  if (slashIdx > 0) {
    const role = ref.slice(0, slashIdx).toLowerCase()
    const name = ref.slice(slashIdx + 1)

    if (!VALID_ROLES.has(role)) {
      throw new Error(`Unknown ARIA role: "${role}". Use a valid WAI-ARIA role`)
    }

    if (!name) {
      throw new Error(`Empty name in role target: "${ref}"`)
    }

    return { strategy: 'role', role, name, value: ref }
  }

  // Bare role without name: "button" → getByRole('button')
  const lower = ref.toLowerCase()
  if (VALID_ROLES.has(lower)) {
    return { strategy: 'role', role: lower, value: ref }
  }

  throw new Error(
    `Invalid target ref: "${ref}". ` +
      'Use "role/Name", "text:value", "label:value", "placeholder:value", "testid:value", "title:value", or "css:selector"',
  )
}

/**
 * Resolve a target ref string to a Playwright Locator on the given page.
 */
export function resolveTarget(page: Page, ref: string): Locator {
  const target = parseTarget(ref)

  switch (target.strategy) {
    case 'role':
      if (target.name) {
        return page.getByRole(target.role as AriaRole, { name: target.name })
      }
      return page.getByRole(target.role as AriaRole)
    case 'text':
      return page.getByText(target.value)
    case 'label':
      return page.getByLabel(target.value)
    case 'placeholder':
      return page.getByPlaceholder(target.value)
    case 'testid':
      return page.getByTestId(target.value)
    case 'title':
      return page.getByTitle(target.value)
    case 'css':
      return page.locator(target.value)
  }
}
