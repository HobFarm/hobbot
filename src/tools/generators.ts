// Surface generators: convert ToolManifest to MCP or chat registration format.
// These are thin adapters, not frameworks.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ToolManifest } from './types'
import { wrapWithHooks } from './hooks'

/**
 * Register a tool on the MCP server from its manifest.
 * The handler is provided by the registering worker (not the manifest).
 * When env is provided, hooks declared in the manifest are wired up.
 */
export function registerMcpTool(
  manifest: ToolManifest,
  server: McpServer,
  handler: (params: Record<string, unknown>) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>,
  env?: unknown,
): void {
  let wrapped = handler
  if (env) {
    wrapped = wrapWithHooks(manifest, handler, env)
  } else if (manifest.hooks?.pre?.length || manifest.hooks?.post?.length) {
    console.warn(`${manifest.name} declares hooks but env not provided; hooks skipped`)
  }

  server.tool(
    manifest.name,
    manifest.description,
    manifest.inputSchema.shape,
    wrapped as any,
  )
}

/**
 * Chat tool entry shape matching GrimoireTool in tool-catalog.ts.
 * The execute handler is NOT included; callers attach it separately.
 */
export interface ChatToolDef {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

/**
 * Convert a manifest to a chat tool definition (name, description, JSON Schema).
 * The caller is responsible for attaching the execute handler.
 */
export function toChatToolDef(manifest: ToolManifest): ChatToolDef {
  // Zod v4 native JSON Schema conversion
  const jsonSchema = manifest.inputSchema.toJSONSchema() as Record<string, unknown>
  // Remove $schema key (chat tool format doesn't need it)
  delete jsonSchema['$schema']
  // Remove additionalProperties (Workers AI tool calling chokes on it)
  delete jsonSchema['additionalProperties']

  return {
    name: manifest.name,
    description: manifest.description,
    input_schema: jsonSchema,
  }
}
