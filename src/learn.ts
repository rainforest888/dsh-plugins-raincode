/**
 * raincode_learn:用户说"学习这次任务/把经验沉淀成 skill"时,
 * chat 模型整理本次任务与经验,交给 gateway 的主控模型生成 SKILL.md,
 * 产物进入 review 隔离区,用户 approve 后才转正。
 */

interface LearnArgs {
  task?: string
  transcript?: string
  category?: string
}

export function registerLearnTool(
  ctx: { tools: { register: (def: unknown) => unknown } },
  baseURL: () => string,
): void {
  ctx.tools.register({
    name: 'raincode_learn',
    description: [
      'Learn from the current task and distill it into a raincode SKILL.md (short checklist, max 20 lines).',
      '',
      'Call when the user says something like "学习一下这次任务" / "把这次的教训沉淀成 skill".',
      'The generated skill goes to the raincode review area first; the user approves it before it becomes active.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Short task/topic signature for the new skill' },
        transcript: { type: 'string', description: 'Optional distilled experience: what worked, what failed, commands, gotchas' },
        category: { type: 'string', description: 'Optional skill category, e.g. testing.rust' },
      },
      required: ['task'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      render: (_args: unknown, value: { text: string }) => [{ type: 'text', text: value.text }],
    },
    async execute(args: LearnArgs) {
      const task = typeof args.task === 'string' ? args.task.trim() : ''
      if (task === '') return { text: 'raincode_learn: `task` is required.' }
      try {
        const resp = await fetch(`${baseURL().replace(/\/+$/, '')}/learn`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            task,
            ...(typeof args.transcript === 'string' && args.transcript.trim() !== '' ? { transcript: args.transcript.trim() } : {}),
            ...(typeof args.category === 'string' && args.category.trim() !== '' ? { category: args.category.trim() } : {}),
          }),
        })
        if (!resp.ok) {
          const payload = (await resp.json().catch(() => null)) as { error?: { message?: string } } | null
          return { text: `raincode_learn failed (HTTP ${resp.status}): ${payload?.error?.message ?? 'unknown error'}` }
        }
        const data = (await resp.json()) as { skill?: { name?: string; category?: string; description?: string; body?: string } }
        const skill = data.skill ?? {}
        return {
          text: [
            '# learned skill (review pending)',
            `name: ${skill.name ?? 'unknown'}`,
            `category: ${skill.category ?? 'unknown'}`,
            '',
            skill.body ?? '',
          ].join('\n'),
        }
      } catch (error) {
        return { text: `raincode_learn failed: ${String((error as Error)?.message ?? error)}` }
      }
    },
  })
}
