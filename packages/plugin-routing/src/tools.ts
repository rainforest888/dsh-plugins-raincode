/** raincode 模型能力刷新工具:用户在对话里说"帮我查看 xx 模型的能力"时由模型调用。 */

export function registerCapabilityTools(
  ctx: { tools: { register: (def: unknown) => unknown } },
  baseURL: () => string,
): void {
  ctx.tools.register({
    name: 'raincode_refresh_model',
    description: [
      'Fetch and refresh one model\'s capability profile from authoritative sources',
      '(OpenRouter Artificial-Analysis indices, DeepSWE leaderboard, and official model reports).',
      '',
      'Call this tool when the user asks to check a model\'s capability, for example:',
      '"帮我查看 kimi-k3 的能力" / "check what qwen3.8-max is good at".',
      'Do NOT call it for ordinary coding tasks; it performs network scraping and is only for model research.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model name to research, e.g. kimi-k3 or qwen3.8-max' },
      },
      required: ['model'],
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
    async execute(args: { model?: string }) {
      const model = typeof args.model === 'string' ? args.model.trim() : ''
      if (model === '') return { text: 'raincode_refresh_model: `model` is required.' }
      try {
        const resp = await fetch(`${baseURL().replace(/\/+$/, '')}/capabilities/refresh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model }),
        })
        if (!resp.ok) {
          const payload = (await resp.json().catch(() => null)) as { error?: { message?: string } } | null
          return { text: `raincode capability refresh failed (HTTP ${resp.status}): ${payload?.error?.message ?? 'unknown error'}` }
        }
        const profile = (await resp.json()) as {
          model?: string
          confidence?: string
          capability?: Record<string, number | null>
          directions?: Record<string, number | null>
          benchmarks?: Record<string, number | null>
          cost_efficiency?: Record<string, number | null>
          sources?: string[]
        }
        const fmt = (v: number | null | undefined): string => v === null || v === undefined ? 'n/a' : (v >= 1 ? `${v.toFixed(1)}%` : v.toFixed(2))
        const lines = [
          `# ${profile.model ?? model}`,
          `confidence: ${profile.confidence ?? 'n/a'} (sources: ${(profile.sources ?? []).join(', ') || 'none'})`,
          '',
          '## capability (0-1)',
          `main=${fmt(profile.capability?.main)} coding=${fmt(profile.capability?.coding)} agentic=${fmt(profile.capability?.agentic)}`,
          `reasoning=${fmt(profile.capability?.reasoning)} knowledge=${fmt(profile.capability?.knowledge)}`,
          '',
          '## directions (0-1)',
          Object.entries(profile.directions ?? {}).map(([k, v]) => `${k}=${fmt(v as number | null)}`).join(' ') || 'n/a',
          '',
          '## key benchmarks',
          `DeepSWE=${fmt(profile.benchmarks?.deepswe_pass1)} HLE=${fmt(profile.benchmarks?.hle)} SWE-verified=${fmt(profile.benchmarks?.swe_verified)}`,
          `AA coding=${fmt(profile.benchmarks?.aa_coding_index)} AA agentic=${fmt(profile.benchmarks?.aa_agentic_index)}`,
        ]
        return { text: lines.join('\n') }
      } catch (error) {
        return { text: `raincode capability refresh failed: ${String((error as Error)?.message ?? error)}` }
      }
    },
  })
}
