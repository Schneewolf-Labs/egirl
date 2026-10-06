/**
 * A task run's wall-clock deadline that can move. A fixed setTimeout could not honour an
 * extension: the abort and the runner's timeout race both have to follow the deadline when a
 * request_extension grant pushes it out. On expiry `onExpire` runs first (the runner aborts the
 * agent with reason 'timeout'), then `expired` rejects with the timeout error the race expects.
 */
export class RunDeadline {
  private atMs: number
  private extendedMs = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private fired = false
  private rejectExpired: (err: Error) => void = () => {}
  /** Rejects with `Task timed out after <ms>ms` when the (possibly extended) deadline passes. */
  readonly expired: Promise<never>

  constructor(
    private readonly budgetMs: number,
    private readonly onExpire: () => void,
  ) {
    this.atMs = Date.now() + budgetMs
    this.expired = new Promise<never>((_, reject) => {
      this.rejectExpired = reject
    })
    // The race normally observes the rejection; a run that settles first must not leave it unhandled.
    this.expired.catch(() => {})
    this.arm()
  }

  /** Wall-clock instant (ms epoch) the run will be hard-aborted. */
  get at(): number {
    return this.atMs
  }

  /** Total time granted beyond the original budget. */
  get extended(): number {
    return this.extendedMs
  }

  get hasFired(): boolean {
    return this.fired
  }

  /** Move the deadline out by `ms`. False once it has already fired. */
  extend(ms: number): boolean {
    if (this.fired || ms <= 0) return false
    this.atMs += ms
    this.extendedMs += ms
    this.arm()
    return true
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  private arm(): void {
    this.clear()
    this.timer = setTimeout(
      () => {
        this.fired = true
        this.onExpire()
        this.rejectExpired(new Error(`Task timed out after ${this.budgetMs + this.extendedMs}ms`))
      },
      Math.max(0, this.atMs - Date.now()),
    )
  }
}
