import { RunDeadline } from '../../src/tasks/deadline'
const t0 = Date.now()
const log = (m: string) => console.log(`${String(Date.now() - t0).padStart(5)}ms ${m}`)

// A: plain re-arm
await new Promise<void>((resolve) => {
  let h = setTimeout(() => log('A: first timer fired (should not)'), 100)
  clearTimeout(h)
  h = setTimeout(() => { log('A: re-armed timer fired'); resolve() }, 400)
})

// B: RunDeadline without the sleep
{
  const d = new RunDeadline(100, () => log('B: onExpire'))
  d.extend(300)
  await d.expired.catch((e) => log(`B: rejected: ${e.message}`))
}

// C: RunDeadline with Bun.sleep(200) in between, like the test
{
  const d = new RunDeadline(100, () => log('C: onExpire'))
  d.extend(300)
  await Bun.sleep(200)
  log('C: slept')
  await d.expired.catch((e) => log(`C: rejected: ${e.message}`))
}
log('all done')
