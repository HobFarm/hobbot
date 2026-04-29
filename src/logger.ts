// Shared structured logger. Outputs JSON to console.log for Cloudflare log search.
// Usage: const log = createLogger('grimoire')
//        log.info('Phase 1 complete', { count: 42, duration_ms: 120 })

export interface Logger {
  info(message: string, context?: Record<string, unknown>): void
  warn(message: string, context?: Record<string, unknown>): void
  error(message: string, context?: Record<string, unknown>): void
}

export function createLogger(worker: string): Logger {
  function log(level: string, message: string, context?: Record<string, unknown>) {
    console.log(JSON.stringify({
      level,
      worker,
      ts: new Date().toISOString(),
      message,
      ...context,
    }))
  }
  return {
    info: (msg, ctx) => log('info', msg, ctx),
    warn: (msg, ctx) => log('warn', msg, ctx),
    error: (msg, ctx) => log('error', msg, ctx),
  }
}
