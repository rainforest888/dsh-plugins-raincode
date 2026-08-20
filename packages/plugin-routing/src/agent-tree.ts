/**
 * raincode_agent_tree:把 dsh 原生 subagent lineage 渲染成父子关系树。
 *
 * dsh 的 Web UI 已经在会话头部提供可展开的 subagent catalog(点击任意深度
 * 打开对应 child)。这个工具是模型侧补充:当用户问"现在哪个子代理派了哪些
 * 孙代理"时,模型调用它拿到结构化父子关系并汇报。
 */

interface DescendantEntry {
  id?: string
  parentId?: string
  depth?: number
  label?: string
  mode?: string
  activity?: string
  hasChildren?: boolean
}

export interface AgentTreeDeps {
  subagents: {
    listDescendants?: (rootSessionId: string, signal?: AbortSignal) => Promise<DescendantEntry[]>
  }
}

export function registerAgentTreeTool(
  ctx: { tools: { register: (def: unknown) => unknown } },
  deps: () => AgentTreeDeps,
): void {
  ctx.tools.register({
    name: 'raincode_agent_tree',
    description: [
      'Show the current subagent delegation tree with explicit parent-child relations',
      '(which subagent started which grand-subagents).',
      '',
      'Call when the user asks about subagent/grand-subagent work status, e.g.',
      '"现在子代理派了哪些孙代理?" / "show the agent tree".',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      render: (_args: unknown, value: { text: string }) => [{ type: 'text', text: value.text }],
    },
    async execute(_args: Record<string, never>, exec?: { agent?: { id?: string }; signal?: AbortSignal }) {
      const subagents = deps().subagents
      if (subagents.listDescendants === undefined) {
        return { text: 'raincode_agent_tree: `listDescendants` is unavailable on this dsh subagent seam.' }
      }
      const rootId = exec?.agent?.id
      if (rootId === undefined || rootId === '') return { text: 'raincode_agent_tree: no agent session id available.' }
      try {
        const entries = await subagents.listDescendants(rootId, exec?.signal)
        const children = new Map<string, DescendantEntry[]>()
        for (const entry of entries) {
          const parent = entry.parentId ?? rootId
          const list = children.get(parent) ?? []
          list.push(entry)
          children.set(parent, list)
        }
        const seen = new Set<string>()
        const render = (id: string, depth: number, name: string): string[] => {
          const lines: string[] = []
          const kids = (children.get(id) ?? []).sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0))
          for (const kid of kids) {
            if (kid.id === undefined || seen.has(kid.id)) continue
            seen.add(kid.id)
            const label = kid.label ?? kid.id
            const kind = kid.mode === 'continuable' ? 'continuable' : 'one-shot'
            const badge = `${kind} · ${kid.activity ?? 'unknown'}${kid.hasChildren === true ? ' · has children' : ''}`
            lines.push(`${'  '.repeat(depth)}- ${label} (${badge})`)
            lines.push(...render(kid.id, depth + 1, label))
          }
          return lines
        }
        const rootLines = render(rootId, 1, '(current agent)')
        const summary: string[] = []
        for (const [parent, kids] of children) {
          const parentLabel = parent === rootId ? '(current agent)' : parent
          summary.push(`${parentLabel}: ${kids.length} direct subagent${kids.length === 1 ? '' : 's'}`)
        }
        return {
          text: [
            '# raincode agent tree',
            '',
            summary.length > 0 ? summary.join('\n') : '(no subagents found)',
            '',
            ...rootLines,
          ].join('\n'),
        }
      } catch (error) {
        return { text: `raincode_agent_tree failed: ${String((error as Error)?.message ?? error)}` }
      }
    },
  })
}
