import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { startMockGateway } from './test-utils.js'
import { registerSkillTools } from './skill-tools.js'

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

describe('raincode_skill_search / raincode_skill_load', () => {
  it('lists all skills when no query is given', async () => {
    const { ctx, list } = collect()
    registerSkillTools(ctx, () => base.url)
    const tool = list.find((t) => t.name === 'raincode_skill_search')!
    const out = await tool.execute({})
    expect(out.text).toContain('rust-testing')
    expect(out.text).toContain('frontend-figma')
  })

  it('searches skills by keyword across metadata and body', async () => {
    const { ctx, list } = collect()
    registerSkillTools(ctx, () => base.url)
    const tool = list.find((t) => t.name === 'raincode_skill_search')!
    const out = await tool.execute({ query: 'rust' })
    expect(out.text).toContain('rust-testing')
    expect(out.text).not.toContain('frontend-figma')
  })

  it('loads a skill body by exact name', async () => {
    const { ctx, list } = collect()
    registerSkillTools(ctx, () => base.url)
    const tool = list.find((t) => t.name === 'raincode_skill_load')!
    const out = await tool.execute({ name: 'rust-testing' })
    expect(out.text).toContain('# Rust')
    expect(out.text).toContain('cargo test')
  })

  it('reports a missing skill', async () => {
    const { ctx, list } = collect()
    registerSkillTools(ctx, () => base.url)
    const tool = list.find((t) => t.name === 'raincode_skill_load')!
    const out = await tool.execute({ name: 'nope' })
    expect(out.text).toContain('not found')
  })
})