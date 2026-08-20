import { createServer, type Server } from 'node:http'

/** Common mock raincode gateway for tool specs. Routes return canned JSON. */
export function startMockGateway(): Promise<{ url: string; server: Server; hits: Map<string, number> }> {
  const hits = new Map<string, number>()
  const server = createServer(async (req, res) => {
    const route = req.url ?? ''
    hits.set(route, (hits.get(route) ?? 0) + 1)
    res.writeHead(200, { 'content-type': 'application/json' })
    if (route.startsWith('/capabilities/refresh')) {
      res.end(JSON.stringify({
        model: 'qwen3.8-max', confidence: 'high',
        capability: { main: 0.76, coding: 0.78, agentic: 0.72 },
        directions: { frontend: 0.74, backend: 0.66 },
        benchmarks: { deepswe_pass1: 66, hle: 41 },
      }))
      return
    }
    if (route.startsWith('/requests')) {
      res.end(JSON.stringify({ requests: [
        { id: 'r1', time: 1700000000, model: 'deepseek-v4-flash', status: 'completed', duration_ms: 120, usage: { prompt_tokens: 10, completion_tokens: 5 } },
      ] }))
      return
    }
    if (route.startsWith('/profiles')) {
      res.end(JSON.stringify({ profiles: [
        { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', model: 'deepseek-v4-flash', role: 'main' },
      ] }))
      return
    }
    if (route.startsWith('/capabilities')) {
      res.end(JSON.stringify({ profiles: [
        { id: 'qwen3.8-max', name: 'qwen3.8-max', model: 'qwen3.8-max', confidence: 'high', capability: { coding: 0.78 } },
      ] }))
      return
    }
    res.end(JSON.stringify({}))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = addr && typeof addr === 'object' ? addr.port : 0
      resolve({ url: `http://127.0.0.1:${port}`, server, hits })
    })
  })
}