import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { startMockGateway } from './test-utils.js'
import { registerCapabilityTools } from './tools.js'

interface Tool {
  name: string
  execute: (args: Record<string, unknown>) => Promise<{ text: string }>
}

let base: { url: string; server: Server }
beforeAll(async () => { base = await startMockGateway() })
afterAll(async () => { await new Promise((r) => base.server.close(() => r(null))) })

describe('raincode_refresh_model', () => {
  it('fetches and formats a fresh capability profile', async () => {
    const tools: Tool[] = []
    registerCapabilityTools({ tools: { register: (d: unknown) => { tools.push(d as Tool); return undefined } } }, () => base.url)
    const tool = tools.find((t) => t.name === 'raincode_refresh_model')!
    const out = await tool.execute({ model: 'qwen3.8-max' })
    expect(out.text).toContain('qwen3.8-max')
    expect(out.text).toContain('coding=')
    expect(out.text).toContain('DeepSWE')
  })

  it('rejects an empty model name', async () => {
    const tools: Tool[] = []
    registerCapabilityTools({ tools: { register: (d: unknown) => { tools.push(d as Tool); return undefined } } }, () => base.url)
    const tool = tools.find((t) => t.name === 'raincode_refresh_model')!
    const out = await tool.execute({ model: '' })
    expect(out.text).toContain('required')
  })
})