/** raincode skill 工具:skill 网络按需加载,通常先搜索再按精确名称加载正文。 */

interface SkillItem {
  name: string
  category: string
  description: string
  tags?: string[]
  body: string
}

function normalizedBase(baseURL: string): string {
  return baseURL.replace(/\/+$/, '')
}

async function fetchSkills(base: string): Promise<SkillItem[]> {
  const resp = await fetch(`${base}/skills`, { cache: 'no-store' })
  if (!resp.ok) throw new Error(`raincode gateway HTTP ${resp.status}`)
  const data = (await resp.json()) as { skills?: SkillItem[] }
  const skills = Array.isArray(data.skills) ? data.skills : []
  return skills.filter((s) => s !== null && s !== undefined && typeof s.name === 'string')
}

export function registerSkillTools(
  ctx: { tools: { register: (def: unknown) => unknown } },
  baseURL: () => string,
): void {
  ctx.tools.register({
    name: 'raincode_skill_search',
    description: [
      'Search raincode skills by keyword (matches name/description/category/tags/body).',
      'raincode skills are loaded on demand over the network, so usually call',
      'raincode_skill_search first to discover skills, then raincode_skill_load to read the full body.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword(s) to search for; omit or pass an empty string to list all skill names (max 20)' },
      },
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
    async execute(args: { query?: string }) {
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      try {
        const skills = await fetchSkills(normalizedBase(baseURL()))
        if (query === '') {
          const shown = skills.slice(0, 20)
          if (shown.length === 0) return { text: 'no raincode skills found' }
          return { text: `raincode skills (${shown.length}/${skills.length})\n${shown.map((s) => `- ${s.name}`).join('\n')}` }
        }
        const keywords = query.toLowerCase().split(/\s+/).filter(Boolean)
        const matches = skills.filter((s) => {
          const haystack = [
            s.name ?? '',
            s.category ?? '',
            s.description ?? '',
            (s.tags ?? []).join(' '),
            s.body ?? '',
          ].join('\n').toLowerCase()
          return keywords.every((keyword) => haystack.includes(keyword))
        })
        const top = matches.slice(0, 10)
        if (top.length === 0) return { text: `no skills matched "${query}"` }
        return { text: top.map((s) => `${s.name} — ${s.category} — ${s.description}`).join('\n') }
      } catch (error) {
        return { text: `skill search failed: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })

  ctx.tools.register({
    name: 'raincode_skill_load',
    description: [
      'Load a raincode skill body by exact name.',
      'raincode skills are loaded on demand over the network, so usually call',
      'raincode_skill_search first, then raincode_skill_load with the chosen skill name.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact skill name returned by raincode_skill_search' },
      },
      required: ['name'],
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
    async execute(args: { name?: string }) {
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      if (name === '') return { text: 'raincode_skill_load: `name` is required.' }
      try {
        const skills = await fetchSkills(normalizedBase(baseURL()))
        const match = skills.find((s) => s.name === name)
        if (match === undefined) return { text: `skill "${name}" not found` }
        return { text: `# ${match.name} (${match.category})\n\n${match.body}` }
      } catch (error) {
        return { text: `skill load failed: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })
}
