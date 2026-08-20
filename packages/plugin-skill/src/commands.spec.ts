import { describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { registerSkillsCommand } from './commands.js'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'

let server: Server
let port = 0

async function start(): Promise<void> {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ skills: [
      { name: 'coding-cycle', category: 'workflow.coding', description: 'full cycle', body: '# Coding\nsteps' },
      { name: 'git-discipline', category: 'workflow.git', description: 'commit discipline', body: '# Git\nrules' },
    ] }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const a = server.address()
  if (a && typeof a === 'object') port = a.port
}

describe('skills command', () => {
  it('lists skills without input and shows body with a name', async () => {
    await start()
    try {
      const registered: { name: string; handler: (inv: CommandInvocation) => CommandResult | Promise<CommandResult> }[] = []
      const fakeCtx = {
        commands: { register: (def: { name: string; handler: (inv: CommandInvocation) => CommandResult | Promise<CommandResult> }) => { registered.push(def); return () => {} } },
      } as never
      registerSkillsCommand(fakeCtx, () => `http://127.0.0.1:${port}`)
      const cmd = registered[0]
      expect(cmd.name).toBe('skills')
      const list = await cmd.handler({ rawInput: '', signal: new AbortController().signal } as CommandInvocation)
      expect(list.kind).toBe('success')
      const text = (list as { text: string }).text
      expect(text).toContain('coding-cycle')
      const detail = await cmd.handler({ rawInput: 'git-discipline', signal: new AbortController().signal } as CommandInvocation)
      expect((detail as { text: string }).text).toContain('# Git')
      const missing = await cmd.handler({ rawInput: 'nope', signal: new AbortController().signal } as CommandInvocation)
      expect(missing.kind).toBe('error')
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})
