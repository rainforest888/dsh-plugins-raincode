import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { RaincodeAdapter, type RaincodeConnectionOptions } from './adapter.js'
import { resolveRetryPolicy, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

let server: Server
let port = 0
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.url === '/v1/chat/completions') {
        JSON.parse(body) as { model?: string; stop?: string[] }
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
      res.writeHead(404).end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const addr = server.address()
  if (addr && typeof addr === 'object') port = addr.port
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

function policy() {
  return resolveRetryPolicy(undefined, 'raincode: retryPolicy')
}

function conn(): RaincodeConnectionOptions {
  return {
    baseURL: `http://127.0.0.1:${port}`,
    models: [{ id: 'deepseek-v4-flash', name: 'Flash' }],
    streamIdleTimeoutMs: 5000,
    retryPolicy: policy(),
  }
}

function makeOptions(): GenerateOptions {
  return {
    provider: 'raincode', model: 'deepseek-v4-flash',
    messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }],
  }
}

describe('RaincodeAdapter', () => {
  it('streams a chat call into StreamChunks', async () => {
    const adapter = new RaincodeAdapter({ options: conn, resolveApiKey: async () => 'dummy' })
    const out: StreamChunk[] = []
    for await (const chunk of adapter.stream(makeOptions())) out.push(chunk)
    expect(out.some((c) => c.type === 'text-delta' && c.text === 'pong')).toBe(true)
    const usage = out.find((c) => c.type === 'usage')
    expect(usage).toMatchObject({ usage: { inputTokens: 5, outputTokens: 1 } })
    expect(out.find((c) => c.type === 'finish')).toMatchObject({ reason: { kind: 'stop' } })
    // 契约:usage 先于 finish,finish 是最后一个 chunk。
    const usageIdx = out.findIndex((c) => c.type === 'usage')
    const finishIdx = out.findIndex((c) => c.type === 'finish')
    expect(usageIdx).toBeGreaterThan(-1)
    expect(finishIdx).toBe(usageIdx + 1)
    expect(finishIdx).toBe(out.length - 1)
  })

  it('listModels advertises the pool', async () => {
    const adapter = new RaincodeAdapter({ options: conn, resolveApiKey: async () => 'dummy' })
    const models = await adapter.listModels('raincode')
    expect(models.map((m) => m.id)).toContain('deepseek-v4-flash')
  })

  it('listModels fetches the gateway catalog when config models are empty', async () => {
    const adapter = new RaincodeAdapter({
      options: () => ({ ...conn(), models: [] }),
      resolveApiKey: async () => 'dummy',
    })
    const models = await adapter.listModels('raincode')
    expect(models.map((m) => m.id)).toContain('deepseek-v4-flash')
    expect(models[0]).toMatchObject({ provider: 'raincode', name: 'Flash' })
  })

  it('maps 401 to an AUTH LlmError', async () => {
    const badServer = createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'nope' } }))
    })
    await new Promise<void>((r) => badServer.listen(0, '127.0.0.1', () => r()))
    const a = badServer.address()
    const badPort = a && typeof a === 'object' ? a.port : 0
    try {
      const adapter = new RaincodeAdapter({
        options: () => ({ ...conn(), baseURL: `http://127.0.0.1:${badPort}` }),
        resolveApiKey: async () => 'dummy',
      })
      await expect(async () => {
        for await (const _c of adapter.stream(makeOptions())) { /* noop */ }
      }).rejects.toMatchObject({ code: 'AUTH' })
    } finally {
      await new Promise<void>((r) => badServer.close(() => r()))
    }
  })

  it('maps an aborted caller signal to an ABORTED LlmError', async () => {
    const adapter = new RaincodeAdapter({ options: conn, resolveApiKey: async () => 'dummy' })
    const controller = new AbortController()
    controller.abort()
    await expect(async () => {
      for await (const _c of adapter.stream({ ...makeOptions(), signal: controller.signal })) { /* noop */ }
    }).rejects.toMatchObject({ code: 'ABORTED' })
  })
})
