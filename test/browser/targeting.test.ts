import { describe, test, expect } from 'bun:test'
import { parseTarget, type TargetRef } from '../../src/browser/targeting'

describe('parseTarget', () => {
  describe('role/name format', () => {
    test('parses button/Submit', () => {
      const result = parseTarget('button/Submit')
      expect(result).toEqual({
        strategy: 'role',
        role: 'button',
        name: 'Submit',
        value: 'button/Submit',
      })
    })

    test('parses link/Home', () => {
      const result = parseTarget('link/Home')
      expect(result).toEqual({
        strategy: 'role',
        role: 'link',
        name: 'Home',
        value: 'link/Home',
      })
    })

    test('parses heading/Welcome to the site', () => {
      const result = parseTarget('heading/Welcome to the site')
      expect(result).toEqual({
        strategy: 'role',
        role: 'heading',
        name: 'Welcome to the site',
        value: 'heading/Welcome to the site',
      })
    })

    test('parses textbox/Email', () => {
      const result = parseTarget('textbox/Email')
      expect(result.strategy).toBe('role')
      expect(result.role).toBe('textbox')
      expect(result.name).toBe('Email')
    })

    test('normalizes role to lowercase', () => {
      const result = parseTarget('Button/Submit')
      expect(result.role).toBe('button')
    })

    test('preserves name case', () => {
      const result = parseTarget('button/Sign Up Now')
      expect(result.name).toBe('Sign Up Now')
    })

    test('handles name with slashes', () => {
      const result = parseTarget('link/docs/api')
      expect(result.strategy).toBe('role')
      expect(result.role).toBe('link')
      expect(result.name).toBe('docs/api')
    })

    test('rejects unknown ARIA role', () => {
      expect(() => parseTarget('hamburger/Menu')).toThrow('Unknown ARIA role')
    })

    test('rejects empty name after role', () => {
      expect(() => parseTarget('button/')).toThrow('Empty name')
    })
  })

  describe('bare role format', () => {
    test('parses bare button role', () => {
      const result = parseTarget('button')
      expect(result).toEqual({
        strategy: 'role',
        role: 'button',
        value: 'button',
      })
    })

    test('parses bare navigation role', () => {
      const result = parseTarget('navigation')
      expect(result.strategy).toBe('role')
      expect(result.role).toBe('navigation')
    })

    test('normalizes case for bare roles', () => {
      const result = parseTarget('CHECKBOX')
      expect(result.role).toBe('checkbox')
    })
  })

  describe('text: strategy', () => {
    test('parses text:Welcome back', () => {
      const result = parseTarget('text:Welcome back')
      expect(result).toEqual({
        strategy: 'text',
        value: 'Welcome back',
      })
    })

    test('preserves colons in value', () => {
      const result = parseTarget('text:Error: something went wrong')
      expect(result.value).toBe('Error: something went wrong')
    })

    test('rejects empty text value', () => {
      expect(() => parseTarget('text:')).toThrow('Empty value')
    })
  })

  describe('label: strategy', () => {
    test('parses label:Email address', () => {
      const result = parseTarget('label:Email address')
      expect(result).toEqual({
        strategy: 'label',
        value: 'Email address',
      })
    })
  })

  describe('placeholder: strategy', () => {
    test('parses placeholder:Search...', () => {
      const result = parseTarget('placeholder:Search...')
      expect(result).toEqual({
        strategy: 'placeholder',
        value: 'Search...',
      })
    })
  })

  describe('testid: strategy', () => {
    test('parses testid:submit-btn', () => {
      const result = parseTarget('testid:submit-btn')
      expect(result).toEqual({
        strategy: 'testid',
        value: 'submit-btn',
      })
    })
  })

  describe('title: strategy', () => {
    test('parses title:Close dialog', () => {
      const result = parseTarget('title:Close dialog')
      expect(result).toEqual({
        strategy: 'title',
        value: 'Close dialog',
      })
    })
  })

  describe('css: strategy', () => {
    test('parses css:#submit', () => {
      const result = parseTarget('css:#submit')
      expect(result).toEqual({
        strategy: 'css',
        value: '#submit',
      })
    })

    test('parses css:.btn-primary', () => {
      const result = parseTarget('css:.btn-primary')
      expect(result.strategy).toBe('css')
      expect(result.value).toBe('.btn-primary')
    })

    test('parses complex CSS selectors', () => {
      const result = parseTarget('css:div.container > form input[type="email"]')
      expect(result.strategy).toBe('css')
      expect(result.value).toBe('div.container > form input[type="email"]')
    })
  })

  describe('error cases', () => {
    test('rejects empty string', () => {
      expect(() => parseTarget('')).toThrow('Invalid target ref')
    })

    test('rejects nonsense string', () => {
      expect(() => parseTarget('xyzzy123')).toThrow('Invalid target ref')
    })

    test('rejects unknown prefix with colon', () => {
      // Unknown colon-prefix falls through; if not a valid role, throws
      expect(() => parseTarget('bogus:value')).toThrow('Invalid target ref')
    })
  })
})
