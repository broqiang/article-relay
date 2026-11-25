type Target = { taskId: string; runId: string }

export function monitorJuejinAudits(check: (target: Target) => Promise<void>) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const keyOf = ({ taskId, runId }: Target) => `${taskId}/${runId}`
  let closed = false

  function schedule(key: string, target: Target, delay: number): void {
    const timer = setTimeout(async () => {
      try { await check(target) } catch { /* A transient failure leaves the record pending. */ }
      if (timers.get(key) === timer) schedule(key, target, 60_000)
    }, delay)
    timers.set(key, timer)
  }

  return {
    sync(targets: Target[]): void {
      if (closed) return
      const active = new Map(targets.map((target) => [keyOf(target), target]))
      for (const [key, timer] of timers) {
        if (active.has(key)) continue
        clearTimeout(timer)
        timers.delete(key)
      }
      for (const [key, target] of active) {
        if (!timers.has(key)) schedule(key, target, 30_000)
      }
    },
    close(): void {
      closed = true
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    },
  }
}
