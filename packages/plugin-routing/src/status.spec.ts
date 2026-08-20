import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { startMockGateway } from './test-utils.js'
import { registerStatusTools } from './status.js'

interface Tool {
  name: string
  execute: (args: Record<string, never>) => Promise<{ text: string }>
}

let base: { url: string; server: Server }
beforeAll(async () => { base = await startMockGateway() })
afterAll(async () => { await new Promise((r) => base.server.close(() => r(null))) })

describe('raincode_status', () => {
  it('renders recent requests and model pool', async () => {
    const tools: Tool[] = []
    registerStatusTools({ tools: { register: (d: unknown) => { tools.push(d as Tool); return undefined } } }, () => base.url)
    const tool = tools.find((t) => t.name === 'raincode_status')!
    const out = await tool.execute({})
    expect(out.text).toContain('recent requests')
    expect(out.text).toContain('deepseek-v4-flash')
  })
})