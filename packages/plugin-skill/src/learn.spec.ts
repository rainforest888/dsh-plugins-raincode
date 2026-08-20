import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { startMockGateway } from './test-utils.js'
import { registerLearnTool } from './learn.js'

interface Tool {
  name: string
  execute: (args: Record<string, unknown>) => Promise<{ text: string }>
}

let base: { url: string; server: Server }
beforeAll(async () => { base = await startMockGateway() })
afterAll(async () => { await new Promise((r) => base.server.close(() => r(null))) })

function collect(): { ctx: { tools: { register: (def: unknown) => unknown } }; list: Tool[] } {
  const list: Tool[] = []
  return { ctx: { tools: { register: (def: unknown) => { list.push(def as Tool); return undefined } } }, list }
}

describe('raincode_learn', () => {
  it('posts a task to the gateway and renders the review-pending skill', async () => {
    const { ctx, list } = collect()
    registerLearnTool(ctx, () => base.url)
    const tool = list.find((t) => t.name === 'raincode_learn')!
    const out = await tool.execute({ task: 'testing.rust loop', transcript: 'worked: run fast' })
    expect(out.text).toContain('review pending')
    expect(out.text).toContain('testing.rust loop')
    expect(out.text).toContain('1. do')
  })

  it('requires a task', async () => {
    const { ctx, list } = collect()
    registerLearnTool(ctx, () => base.url)
    const tool = list.find((t) => t.name === 'raincode_learn')!
    const out = await tool.execute({})
    expect(out.text).toContain('required')
  })
})