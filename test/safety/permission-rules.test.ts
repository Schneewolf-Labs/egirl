import { describe, expect, test } from 'bun:test'
import {
  parseRule,
  globToRegex,
  checkPermissionRules,
  compilePermissionRules,
  type PermissionRule,
} from '../../src/safety/permission-rules'

describe('globToRegex', () => {
  test('matches exact string', () => {
    const re = globToRegex('hello')
    expect(re.test('hello')).toBe(true)
    expect(re.test('hello_world')).toBe(false)
  })

  test('* matches any non-slash sequence', () => {
    const re = globToRegex('git *')
    expect(re.test('git status')).toBe(true)
    expect(re.test('git commit')).toBe(true)
    expect(re.test('gitx')).toBe(false)
  })

  test('** matches anything including slashes', () => {
    const re = globToRegex('/home/**')
    expect(re.test('/home/user/file.ts')).toBe(true)
    expect(re.test('/home/user/deep/nested/path')).toBe(true)
    expect(re.test('/etc/passwd')).toBe(false)
  })

  test('? matches single character', () => {
    const re = globToRegex('file?.txt')
    expect(re.test('file1.txt')).toBe(true)
    expect(re.test('fileX.txt')).toBe(true)
    expect(re.test('file.txt')).toBe(false)
    expect(re.test('file12.txt')).toBe(false)
  })

  test('escapes regex special chars', () => {
    const re = globToRegex('file.txt')
    expect(re.test('file.txt')).toBe(true)
    expect(re.test('fileXtxt')).toBe(false)
  })

  test('handles complex patterns', () => {
    const re = globToRegex('/src/**/*.ts')
    expect(re.test('/src/index.ts')).toBe(true)
    expect(re.test('/src/util/logger.ts')).toBe(true)
    expect(re.test('/src/deep/nested/file.ts')).toBe(true)
    expect(re.test('/src/file.js')).toBe(false)
    expect(re.test('/other/file.ts')).toBe(false)
  })
})

describe('parseRule', () => {
  test('parses tool-only rule', () => {
    const rule = parseRule('execute_command', 'allow')
    expect(rule.action).toBe('allow')
    expect(rule.tool).toBe('execute_command')
    expect(rule.argPattern).toBeUndefined()
    expect(rule._toolRegex.test('execute_command')).toBe(true)
  })

  test('parses tool with arg pattern', () => {
    const rule = parseRule('execute_command(git *)', 'allow')
    expect(rule.action).toBe('allow')
    expect(rule.tool).toBe('execute_command')
    expect(rule.argPattern).toBe('git *')
    expect(rule._argRegex!.test('git status')).toBe(true)
    expect(rule._argRegex!.test('rm -rf /')).toBe(false)
  })

  test('parses wildcard tool', () => {
    const rule = parseRule('*', 'deny')
    expect(rule._toolRegex.test('any_tool')).toBe(true)
    expect(rule._toolRegex.test('execute_command')).toBe(true)
  })

  test('parses path patterns in args', () => {
    const rule = parseRule('read_file(/home/**)', 'allow')
    expect(rule._argRegex!.test('/home/user/file.ts')).toBe(true)
    expect(rule._argRegex!.test('/etc/passwd')).toBe(false)
  })
})

describe('checkPermissionRules', () => {
  test('returns undefined when no rules match', () => {
    const rules = compilePermissionRules([], [])
    const result = checkPermissionRules('execute_command', { command: 'ls' }, rules)
    expect(result).toBeUndefined()
  })

  test('allows matching allow rule', () => {
    const rules = compilePermissionRules(
      ['execute_command(git *)'],
      [],
    )
    const result = checkPermissionRules('execute_command', { command: 'git status' }, rules)
    expect(result).toBe('allow')
  })

  test('denies matching deny rule', () => {
    const rules = compilePermissionRules(
      [],
      ['execute_command(rm **)'],
    )
    const result = checkPermissionRules('execute_command', { command: 'rm -rf /tmp/foo' }, rules)
    expect(result).toBe('deny')
  })

  test('deny rules take priority over allow rules', () => {
    const rules = compilePermissionRules(
      ['execute_command(**)'], // allow all commands
      ['execute_command(rm **)'], // but deny rm
    )
    const result = checkPermissionRules('execute_command', { command: 'rm file.txt' }, rules)
    expect(result).toBe('deny')
  })

  test('allows when deny does not match but allow does', () => {
    const rules = compilePermissionRules(
      ['execute_command(git **)'],
      ['execute_command(rm **)'],
    )
    const result = checkPermissionRules('execute_command', { command: 'git push' }, rules)
    expect(result).toBe('allow')
  })

  test('matches tool name without arg pattern', () => {
    const rules = compilePermissionRules(
      ['read_file'],
      [],
    )
    const result = checkPermissionRules('read_file', { path: '/any/path' }, rules)
    expect(result).toBe('allow')
  })

  test('does not match wrong tool', () => {
    const rules = compilePermissionRules(
      ['read_file'],
      [],
    )
    const result = checkPermissionRules('write_file', { path: '/any/path' }, rules)
    expect(result).toBeUndefined()
  })

  test('wildcard tool matches any tool', () => {
    const rules = compilePermissionRules(
      [],
      ['*'],
    )
    expect(checkPermissionRules('read_file', {}, rules)).toBe('deny')
    expect(checkPermissionRules('execute_command', {}, rules)).toBe('deny')
  })

  test('path-based allow/deny works with read_file', () => {
    const rules = compilePermissionRules(
      ['read_file(/home/**)'],
      ['read_file(/etc/**)'],
    )

    expect(checkPermissionRules('read_file', { path: '/home/user/code.ts' }, rules)).toBe('allow')
    expect(checkPermissionRules('read_file', { path: '/etc/passwd' }, rules)).toBe('deny')
    expect(checkPermissionRules('read_file', { path: '/var/log/syslog' }, rules)).toBeUndefined()
  })

  test('uses primary arg heuristic for different arg names', () => {
    const rules = compilePermissionRules(
      ['web_research(*)'],
      [],
    )
    // web_research uses 'query' as its arg
    const result = checkPermissionRules('web_research', { query: 'how to code' }, rules)
    expect(result).toBe('allow')
  })

  test('falls back to first string arg', () => {
    const rules = compilePermissionRules(
      ['custom_tool(hello *)'],
      [],
    )
    const result = checkPermissionRules('custom_tool', { data: 'hello world' }, rules)
    expect(result).toBe('allow')
  })

  test('handles empty args gracefully', () => {
    const rules = compilePermissionRules(
      ['read_file(/home/**)'],
      [],
    )
    // Tool matches but no arg to check, so arg pattern can't match
    const result = checkPermissionRules('read_file', {}, rules)
    expect(result).toBeUndefined()
  })
})

describe('compilePermissionRules', () => {
  test('compiles deny rules before allow rules', () => {
    const rules = compilePermissionRules(
      ['execute_command(git **)'],
      ['execute_command(rm **)'],
    )
    // First 1 rules should be deny, last 1 should be allow
    expect(rules[0]!.action).toBe('deny')
    expect(rules[1]!.action).toBe('allow')
  })

  test('handles empty arrays', () => {
    const rules = compilePermissionRules([], [])
    expect(rules).toHaveLength(0)
  })

  test('compiles multiple rules', () => {
    const rules = compilePermissionRules(
      ['read_file', 'execute_command(git **)'],
      ['write_file(/etc/**)', 'execute_command(rm **)'],
    )
    expect(rules).toHaveLength(4)
    // Deny rules first
    expect(rules[0]!.action).toBe('deny')
    expect(rules[1]!.action).toBe('deny')
    // Then allow rules
    expect(rules[2]!.action).toBe('allow')
    expect(rules[3]!.action).toBe('allow')
  })
})
