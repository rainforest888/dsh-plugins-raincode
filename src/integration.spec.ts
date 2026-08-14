import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import LlmService, { type StreamChunk } from '@deepseek-ai/dsh-llm'
import * as plugin from './index.js'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'

/**
 * 端到端适配验证:真实 cordis Context + 真实 LlmService + 本插件 apply。
 * 证明插件能在 dsh 的插件契约下注册 provider、流式调用、发现模型并注册 /skills 命令
 * (settings/credentials 服务缺席时走其官方兜底路径:installSettingsSection 跳过、
 * launchEnvironmentOf 回退 process.env)。
 */

let server: Server
let port = 0
const chatBodies: Record<string, unknown>[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.url === '/v1/chat/completions') {
        chatBodies.push(JSON.parse(body) as Record<string, unknown>)
        const chunks = [
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'pong' }, index: 0 }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } })}\n\n`,
          'data: [DONE]\n\n',
        ]
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(chunks.join(''))
        return
      }
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-v4-flash', name: 'Flash' }] }))
        return
      }
      if (req.url === '/skills') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ skills: [
          { name: 'probe', category: 'probe', description: 'probe skill', body: '# Probe\nbody' },
        ] }))
        return
      }
      res.writeHead(404).end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const addr = server.address()
  if (addr && typeof addr === 'object') port = addr.port
  process.env.TEST_RAINCODE_KEY = 'dummy'
})
afterAll(async () => {
  delete process.env.TEST_RAINCODE_KEY
  await new Promise<void>((r) => server.close(() => r()))
})

interface RegisteredCommand {
  name: string
  handler: (inv: CommandInvocation) => CommandResult | Promise<CommandResult>
}

type DisposableFiber = { dispose: () => Promise<void> }

async function startHarness(): Promise<{ ctx: Context; commands: RegisteredCommand[]; dispose: () => Promise<void> }> {
  const ctx = new Context()
  const fibers: DisposableFiber[] = []
  fibers.push(ctx.plugin(LlmService) as unknown as DisposableFiber)
  const commands: RegisteredCommand[] = []
  ctx.provide('commands', {
    register: (def: { name: string; handler: (inv: CommandInvocation) => CommandResult | Promise<CommandResult> }) => {
      commands.push(def)
      return () => {}
    },
  })
  // 与 dsh 加载器一致:Config schema 校验 + apply。
  const fiber = await ctx.plugin(
    { name: plugin.name, inject: plugin.inject, Config: plugin.Config, apply: plugin.apply },
    { baseURL: `http://127.0.0.1:${port}`, apiKeyEnv: 'TEST_RAINCODE_KEY', models: [], streamIdleTimeoutMs: 5000 },
  )
  fibers.push(fiber as unknown as DisposableFiber)
  const dispose = async (): Promise<void> => {
    for (const f of fibers) await f.dispose()
  }
  return { ctx, commands, dispose }
}

describe('plugin in a real dsh context', () => {
  it('registers the raincode provider and streams chunks through LlmService', async () => {
    const { ctx, dispose } = await startHarness()
    try {
      const providers = ctx.llm.listProviders()
      expect(providers.map((p) => p.id)).toContain('raincode')
      expect(providers.find((p) => p.id === 'raincode')).toMatchObject({ name: 'Raincode' })

      const out: StreamChunk[] = []
      for await (const chunk of ctx.llm.stream({
        provider: 'raincode',
        model: 'deepseek-v4-flash',
        messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }],
        stop: ['END'],
        sessionId: 'sess-1',
        maxTokens: 16,
      })) out.push(chunk)

      expect(out.some((c) => c.type === 'text-delta' && c.text === 'pong')).toBe(true)
      const usageIdx = out.findIndex((c) => c.type === 'usage')
      const finishIdx = out.findIndex((c) => c.type === 'finish')
      expect(usageIdx).toBeGreaterThan(-1)
      expect(finishIdx).toBe(usageIdx + 1)
      expect(out[out.length - 1]).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })

      // 完整 wire 链:GenerateOptions → 请求体 stop/session_id。
      const body = chatBodies[chatBodies.length - 1]
      expect(body['stop']).toEqual(['END'])
      expect(body['session_id']).toBe('sess-1')
      expect(body['stream']).toBe(true)
    } finally {
      await dispose()
    }
  })

  it('lists models from the gateway catalog and resolves model metadata', async () => {
    const { ctx, dispose } = await startHarness()
    try {
      const models = await ctx.llm.listModels('raincode')
      expect(models.map((m) => m.id)).toContain('deepseek-v4-flash')
      const resolved = await ctx.llm.resolveModelInfo('raincode', 'deepseek-v4-flash')
      expect(resolved).toMatchObject({ provider: 'raincode', id: 'deepseek-v4-flash', name: 'Flash' })
    } finally {
      await dispose()
    }
  })

  it('registers the /skills command backed by the gateway', async () => {
    const { commands, dispose } = await startHarness()
    try {
      const cmd = commands.find((c) => c.name === 'skills')
      expect(cmd).toBeDefined()
      const list = await cmd!.handler({ rawInput: '', signal: new AbortController().signal } as CommandInvocation)
      expect(list.kind).toBe('success')
      expect((list as { text: string }).text).toContain('probe')
      const detail = await cmd!.handler({ rawInput: 'probe', signal: new AbortController().signal } as CommandInvocation)
      expect((detail as { text: string }).text).toContain('# Probe')
    } finally {
      await dispose()
    }
  })
})
