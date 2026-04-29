// Tool manifest type system.
// A manifest describes WHAT a tool does and WHERE it's exposed.
// HOW it executes (the handler) is provided at registration time,
// since handlers depend on runtime env bindings that differ between workers.

import { z } from 'zod'

export type ToolSurface = 'mcp' | 'chat'

export type ToolAuth = 'none' | 'session' | 'admin'

export type ToolCategory =
  | 'grimoire'
  | 'pipeline'
  | 'system'
  | 'config'

export interface ToolHooks {
  pre?: string[]
  post?: string[]
}

export interface ToolBudget {
  maxTokens?: number
  maxDurationMs?: number
  rateLimitKey?: string
}

export interface ToolManifest {
  name: string
  description: string
  category: ToolCategory
  surfaces: ToolSurface[]
  auth: ToolAuth
  inputSchema: z.ZodObject<z.ZodRawShape>
  hooks?: ToolHooks
  budget?: ToolBudget
}
