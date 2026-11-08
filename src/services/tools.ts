// MyHub 도구 레지스트리 - MCP 호환
// 새 도구 추가는 registerTool() 호출만으로 가능 (코어 수정 불필요)

export interface ToolDefinition {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties: Record<string, { type: string; description: string }>
    required: string[]
  }
}

export interface ToolResult {
  ok: boolean
  data?: any
  error?: string
}

const registry = new Map<string, { def: ToolDefinition; handler: (args: any) => Promise<ToolResult> }>()

export function registerTool(def: ToolDefinition, handler: (args: any) => Promise<ToolResult>) {
  registry.set(def.name, { def, handler })
}

export function getToolDefinitions(): ToolDefinition[] {
  return Array.from(registry.values()).map((t) => t.def)
}

export async function executeTool(name: string, args: any): Promise<ToolResult> {
  const tool = registry.get(name)
  if (!tool) return { ok: false, error: `Unknown tool: ${name}` }
  try {
    return await tool.handler(args)
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) }
  }
}
