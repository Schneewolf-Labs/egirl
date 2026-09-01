import { describe, expect, test } from 'bun:test'
import { createDelegationControlTools } from '../../src/tools/builtin/code-agent/control-tools'
import { createDelegationRegistry } from '../../src/tools/delegation-registry'

function setup(steerable = true) {
  const registry = createDelegationRegistry()
  const tools = createDelegationControlTools(registry)
  const { id, control } = registry.begin({
    task: 'port the tier-1 batch',
    provider: 'claude',
    workingDir: '/repo',
    steerable,
  })
  return { registry, tools, id, control }
}

describe('code_agent control tools', () => {
  test('status with nothing running says so', async () => {
    const tools = createDelegationControlTools(createDelegationRegistry())
    const result = await tools.statusTool.execute({}, '/repo')
    expect(result.success).toBe(true)
    expect(result.output).toBe('No background delegations.')
  })

  test('status with no id lists every delegation', async () => {
    const { tools, id } = setup()
    const result = await tools.statusTool.execute({}, '/repo')
    expect(result.output).toContain(id)
    expect(result.output).toContain('[running]')
    expect(result.output).toContain('port the tier-1 batch')
  })

  test('status by id shows progress, then the result once it lands', async () => {
    const { registry, tools, id, control } = setup()
    control.onProgress('→ Read')

    const running = await tools.statusTool.execute({ id }, '/repo')
    expect(running.output).toContain('→ Read')
    expect(running.output).not.toContain('result:')

    registry.settle(id, { success: true, output: 'ported 4 files' })
    const finished = await tools.statusTool.execute({ id }, '/repo')
    expect(finished.output).toContain('[done]')
    expect(finished.output).toContain('ported 4 files')
  })

  test('status for an unknown id fails rather than reporting nothing', async () => {
    const { tools } = setup()
    const result = await tools.statusTool.execute({ id: 'nope' }, '/repo')
    expect(result.success).toBe(false)
    expect(result.output).toContain('No delegation with id nope')
  })

  test('steer reaches a running delegation', async () => {
    const { tools, id, control } = setup()
    const result = await tools.steerTool.execute({ id, message: 'keep the old API' }, '/repo')
    expect(result.success).toBe(true)
    expect(await control.nextSteer()).toBe('keep the old API')
  })

  test('steer on an unsteerable backend explains what to do instead', async () => {
    const { tools, id } = setup(false)
    const result = await tools.steerTool.execute({ id, message: 'change course' }, '/repo')
    expect(result.success).toBe(false)
    expect(result.output).toContain('code_agent_stop')
  })

  test('steer requires both id and message', async () => {
    const { tools, id } = setup()
    const result = await tools.steerTool.execute({ id }, '/repo')
    expect(result.success).toBe(false)
    expect(result.output).toContain('required')
  })

  test('stop ends a running delegation', async () => {
    const { tools, id, control } = setup()
    const result = await tools.stopTool.execute({ id }, '/repo')
    expect(result.success).toBe(true)
    expect(control.signal.aborted).toBe(true)
  })

  test('stop on a finished delegation fails cleanly', async () => {
    const { registry, tools, id } = setup()
    registry.settle(id, { success: true, output: 'done' })
    const result = await tools.stopTool.execute({ id }, '/repo')
    expect(result.success).toBe(false)
    expect(result.output).toContain('not running')
  })
})
