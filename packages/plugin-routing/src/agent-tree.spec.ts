import { describe, expect, it, vi } from 'vitest'
import { registerAgentTreeTool, type AgentTreeDeps } from './agent-tree.js'

interface Tool {
  name: string
  execute: (args: Record<string, never>, exec?: { agent?: { id?: string }; signal?: AbortSignal }) => Promise<{ text: string }>
}

function collect(): { ctx: { tools: { register: (def: unknown) => unknown } }; list: Tool[] } {
  const list: Tool[] = []
  return { ctx: { tools: { register: (def: unknown) => { list.push(def as Tool); return undefined } } }, list }
}

describe('raincode_agent_tree', () => {
  it('renders a parent-child tree from listDescendants', async () => {
    const { ctx, list } = collect()
    const deps: AgentTreeDeps = {
      subagents: {
        listDescendants: async () => [
          { id: 'child-a', parentId: 'root', depth: 1, label: 'frontend', mode: 'one-shot', activity: 'running', hasChildren: true },
          { id: 'grand-a1', parentId: 'child-a', depth: 2, label: 'css', mode: 'continuable', activity: 'inactive', hasChildren: false },
        ],
      },
    }
    registerAgentTreeTool(ctx, () => deps)
    const tool = list.find((t) => t.name === 'raincode_agent_tree')!
    const out = await tool.execute({}, { agent: { id: 'root' }, signal: new AbortController().signal })
    expect(out.text).toContain('frontend')
    expect(out.text).toContain('css')
    expect(out.text).toContain('has children')
  })

  it('reports when listDescendants is unavailable', async () => {
    const { ctx, list } = collect()
    registerAgentTreeTool(ctx, () => ({ subagents: {} }))
    const tool = list.find((t) => t.name === 'raincode_agent_tree')!
    const out = await tool.execute({}, { agent: { id: 'root' } })
    expect(out.text).toContain('unavailable')
  })

  it('handles missing agent id', async () => {
    const { ctx, list } = collect()
    const deps: AgentTreeDeps = { subagents: { listDescendants: vi.fn(async () => []) } }
    registerAgentTreeTool(ctx, () => deps)
    const tool = list.find((t) => t.name === 'raincode_agent_tree')!
    const out = await tool.execute({}, { agent: {} })
    expect(out.text).toContain('no agent session id')
  })
})