// Grimoire custodian configuration

export const SCAN = {
  FULL_SCAN_HOURS: 6,
  WRITE_VALIDATION_MINUTES: 15,
} as const

export const QUERY = {
  DEFAULT_SEARCH_LIMIT: 20,
  MAX_SEARCH_LIMIT: 100,
  DEFAULT_CORRESPONDENCE_DEPTH: 2,
  MAX_CORRESPONDENCE_DEPTH: 5,
} as const

export const BUDGET = {
  QUERIES_PER_DAY: 1000,
} as const

export const PROVIDER = {
  VALIDATION: 'gemini' as const,
  DEFAULT_MODEL: 'gemini-2.5-flash',
} as const

export const CLEANUP = {
  USAGE_LOG_RETENTION_DAYS: 30,
  SCAN_HISTORY_RETENTION_DAYS: 90,
} as const
