import { describe, expect, it } from 'vitest'
import { registerRouteTools, type RouteToolDeps } from './route.js'

interface Tool {
  name: string
  execute: (args: Record<string, unknown>, exec?: { agent?: unknown; signal?: AbortSignal }) => Promise<{ text: string }>
}

function collect(): { ctx: { tools: { register: (def: unknown) => unknown } }; list: Tool[] } {
  const list: Tool[] = []
  return { ctx: { tools: { register: (def: unknown) => { list.push(def as Tool); return undefined } } }, list }
}

function deps(overrides: Partial<RouteToolDeps> = {}): RouteToolDeps {
  return {
    mainModel: 'deepseek-v4-pro',
    subagentProvider: 'spawn',
    defaultMaxDepth: 3,
    subagents: {
      start: async (_provider, request) => ({
        id: 'run-1',
        result: Promise.resolve({ output: [{ type: 'text', text: 'orchestrated result' }], stopReason: 'completed' }),
        dispose: async () => {},
      }),
    },
    ...overrides,
  }
}

describe('raincode_route', () => {
  it('starts a subagent with provider=raincode and the main model', async () => {
    const { ctx, list } = collect()
    const started: unknown[] = []
    const cfg = deps({
      subagents: {
        start: async (provider, request) => {
          started.push({ provider, request })
          return {
            id: 'run-1',
            result: Promise.resolve({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' }),
            dispose: async () => {},
          }
        },
      },
    })
    registerRouteTools(ctx, () => cfg)
    const tool = list.find((t) => t.name === 'raincode_route')!
    const out = await tool.execute({ prompt: 'build a web app', maxDepth: 2 }, { agent: { id: 'parent' } })
    expect(out.text).toBe('done')
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({ provider: 'spawn' })
  })

  it('requires a prompt', async () => {
    const { ctx, list } = collect()
    registerRouteTools(ctx, () => deps())
    const tool = list.find((t) => t.name === 'raincode_route')!
    const out = await tool.execute({ prompt: '' })
    expect(out.text).toContain('prompt')
  })

  it('rejects when no main model is configured', async () => {
    const { ctx, list } = collect()
    registerRouteTools(ctx, () => deps({ mainModel: '' }))
    const tool = list.find((t) => t.name === 'raincode_route')!
    const out = await tool.execute({ prompt: 'task' }, { agent: { id: 'x' } })
    expect(out.text).toContain('no main model')
  })
})