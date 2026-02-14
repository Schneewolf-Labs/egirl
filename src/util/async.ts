export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function retry<T>(
  fn: () => Promise<T>,
  options: {
    maxAttempts?: number
    delayMs?: number
    backoffMultiplier?: number
    onError?: (error: unknown, attempt: number) => void
  } = {},
): Promise<T> {
  const { maxAttempts = 3, delayMs = 1000, backoffMultiplier = 2, onError } = options

  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      onError?.(error, attempt)

      if (attempt < maxAttempts) {
        const waitTime = delayMs * backoffMultiplier ** (attempt - 1)
        await delay(waitTime)
      }
    }
  }

  throw lastError
}

export function timeout<T>(promise: Promise<T>, ms: number, message?: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(message ?? `Operation timed out after ${ms}ms`)), ms),
    ),
  ])
}

export class AsyncQueue<T> {
  private queue: T[] = []
  private resolvers: Array<(value: T) => void> = []

  push(item: T): void {
    const resolver = this.resolvers.shift()
    if (resolver) {
      resolver(item)
    } else {
      this.queue.push(item)
    }
  }

  async pop(): Promise<T> {
    const item = this.queue.shift()
    if (item !== undefined) {
      return item
    }

    return new Promise<T>((resolve) => {
      this.resolvers.push(resolve)
    })
  }

  get length(): number {
    return this.queue.length
  }
}
