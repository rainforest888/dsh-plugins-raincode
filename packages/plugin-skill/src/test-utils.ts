import { createServer, type Server } from 'node:http'

/** Common mock raincode gateway for skill tool specs. */
export function startMockGateway(): Promise<{ url: string; server: Server }> {
  const server = createServer(async (req, res) => {
    const route = req.url ?? ''
    res.writeHead(200, { 'content-type': 'application/json' })
    if (route.startsWith('/skills')) {
      res.end(JSON.stringify({ skills: [
        { name: 'rust-testing', category: 'testing.rust', description: 'Rust test loop', tags: ['rust'], body: '# Rust\n1. run cargo test\n' },
        { name: 'frontend-figma', category: 'frontend', description: 'Figma to code', tags: ['ui'], body: '# Figma\n1. export tokens\n' },
      ] }))
      return
    }
    if (route.startsWith('/learn')) {
      let body = ''
      req.on('data', (c) => (body += c))
      await new Promise<void>((r) => req.on('end', () => r()))
      const parsed = JSON.parse(body || '{}') as { task?: string }
      res.end(JSON.stringify({
        ok: true,
        review: true,
        skill: { name: parsed.task ?? 'learned', category: 'testing', description: 'ok', body: '1. do\n2. check\n' },
      }))
      return
    }
    res.end(JSON.stringify({}))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = addr && typeof addr === 'object' ? addr.port : 0
      resolve({ url: `http://127.0.0.1:${port}`, server })
    })
  })
}