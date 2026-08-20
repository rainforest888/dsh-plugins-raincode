import type { CommandResult } from '@deepseek-ai/dsh-commands'

interface SkillItem {
  name: string
  category: string
  description: string
  body: string
}

/**
 * 注册 `/skills` 命令:无参数 → 列清单;`/skills <name>` → 看正文。数据来自
 * raincode gateway 的 `/skills`(Rust 侧 SkillStore::discover,不重复解析)。
 */
export function registerSkillsCommand(ctx: { commands: { register: (def: { name: string; description: string; input?: { hint: string }; handler: (inv: { rawInput: string; signal: AbortSignal }) => CommandResult | Promise<CommandResult> }) => unknown } }, baseUrl: () => string): void {
  ctx.commands.register({
    name: 'skills',
    description: 'Browse raincode skills (no arg = list, /skills <name> = view body)',
    input: { hint: '<skill name>' },
    async handler(invocation) {
      const name = invocation.rawInput.trim()
      const url = `${baseUrl().replace(/\/+$/, '')}/skills`
      try {
        const resp = await fetch(url, { signal: invocation.signal })
        if (!resp.ok) throw new Error(`raincode gateway ${resp.status}`)
        const data = (await resp.json()) as { skills: SkillItem[] }
        const skills = data.skills ?? []
        if (name === '') {
          if (skills.length === 0) return { kind: 'success' as const, text: 'no raincode skills found' }
          const lines = skills.map((s) => `- **${s.name}** (${s.category}): ${s.description}`)
          return { kind: 'success' as const, text: `raincode skills (${skills.length})\n\n${lines.join('\n')}` }
        }
        const match = skills.find((s) => s.name === name)
        if (match === undefined) return { kind: 'error' as const, text: `skill "${name}" not found` }
        return { kind: 'success' as const, text: `# ${match.name} (${match.category})\n\n${match.body}` }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { kind: 'error' as const, text: `skills: ${message}` }
      }
    },
  })
}
