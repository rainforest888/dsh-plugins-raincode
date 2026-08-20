/** raincode 状态工具:查询最近模型调用、缓存能力档案与模型池配置。 */

interface RequestUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

interface RequestEntry {
  id?: string
  time?: string | number
  ts?: string | number
  timestamp?: string | number
  created_at?: string | number
  model?: string
  session_id?: string
  purpose?: string
  status?: string
  duration_ms?: number | string
  finish_reason?: string
  usage?: RequestUsage
}

interface SkillLikeProfile {
  id?: string
  name?: string
  model?: string
  role?: string
}

interface CapabilityProfile {
  id?: string
  name?: string
  model?: string
  confidence?: string
  capability?: Record<string, number | null>
  directions?: Record<string, number | null>
}

function normalizedBase(baseURL: string): string {
  return baseURL.replace(/\/+$/, '')
}

async function fetchJson(url: string): Promise<unknown> {
  const resp = await fetch(url, { cache: 'no-store' })
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new Error(`HTTP ${resp.status}${detail.trim() === '' ? '' : `: ${detail.trim().slice(0, 200)}`}`)
  }
  return resp.json()
}

function asString(value: unknown): string {
  if (value === undefined || value === null) return 'n/a'
  const text = String(value)
  return text.length === 0 ? 'n/a' : text
}

function mdCell(value: string): string {
  return value.replace(/\|/g, '\|').replace(/\n/g, ' ')
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}…`
}

function requestTime(entry: RequestEntry): string {
  const value = entry.time ?? entry.ts ?? entry.timestamp ?? entry.created_at
  if (value === undefined || value === null) return 'n/a'
  const numeric = Number(value)
  if (Number.isFinite(numeric) && String(value).trim() !== '') {
    // 秒级时间戳转毫秒(网关若给毫秒级则保持原样)。
    const ms = numeric < 1e12 ? numeric * 1000 : numeric
    const date = new Date(ms)
    if (!Number.isNaN(date.getTime())) return date.toISOString().replace('T', ' ').slice(0, 19)
  }
  const text = String(value)
  return text.length === 0 ? 'n/a' : text
}

function usageSummary(usage: RequestUsage | undefined): string {
  if (usage === undefined) return 'n/a'
  const prompt = usage.prompt_tokens
  const completion = usage.completion_tokens
  const total = usage.total_tokens ?? ((prompt !== undefined && completion !== undefined) ? prompt + completion : undefined)
  if (prompt === undefined && completion === undefined && total === undefined) return 'n/a'
  const p = prompt === undefined ? '?' : String(prompt)
  const c = completion === undefined ? '?' : String(completion)
  const t = total === undefined ? '?' : String(total)
  return `p:${p} c:${c} t:${t}`
}

function formatRequests(data: unknown): string {
  const list = (data as { requests?: RequestEntry[] } | null)?.requests
  if (!Array.isArray(list) || list.length === 0) {
    return '# raincode status\n\n## recent requests\n\n(no requests found)'
  }
  const lines = [
    '# raincode status',
    '',
    '## recent requests',
    '',
    '| time | model | session_id | purpose | status | duration_ms | finish_reason | usage |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const entry of list) {
    const usage = usageSummary(entry.usage)
    lines.push(
      `| ${mdCell(requestTime(entry))} | ${mdCell(asString(entry.model))} | ${mdCell(truncate(asString(entry.session_id), 16))} | ${mdCell(asString(entry.purpose))} | ${mdCell(asString(entry.status))} | ${mdCell(asString(entry.duration_ms))} | ${mdCell(asString(entry.finish_reason))} | ${mdCell(usage)} |`,
    )
  }
  return lines.join('\n')
}

function formatProfiles(data: unknown): string {
  const list = (data as { profiles?: SkillLikeProfile[] } | null)?.profiles
  if (!Array.isArray(list) || list.length === 0) return '## model pool profiles\n\n(no profiles found)'
  const lines = ['## model pool profiles', '']
  for (const p of list) {
    const model = p.model ?? p.id ?? p.name ?? 'n/a'
    const role = p.role === undefined || p.role === '' ? '' : ` (role=${p.role})`
    lines.push(`- ${mdCell(String(model))}${role}`)
  }
  return lines.join('\n')
}

function formatCapabilities(data: unknown): string {
  const list = (data as { profiles?: CapabilityProfile[] } | null)?.profiles
  if (!Array.isArray(list) || list.length === 0) return '## capability profiles\n\n(no capability profiles found)'
  const lines = ['## capability profiles', '']
  for (const p of list) {
    const model = p.model ?? p.name ?? p.id ?? 'n/a'
    const confidence = p.confidence === undefined || p.confidence === '' ? 'n/a' : p.confidence
    const bits: string[] = []
    const capability = p.capability ?? {}
    for (const [k, v] of Object.entries(capability)) {
      if (v !== null && v !== undefined) bits.push(`${k}=${v >= 1 ? `${v.toFixed(1)}%` : v.toFixed(2)}`)
    }
    lines.push(`- ${mdCell(String(model))} (confidence=${confidence})${bits.length > 0 ? `: ${bits.join(' ')}` : ''}`)
  }
  return lines.join('\n')
}

export function registerStatusTools(
  ctx: { tools: { register: (def: unknown) => unknown } },
  baseURL: () => string,
): void {
  ctx.tools.register({
    name: 'raincode_status',
    description: [
      '查询 raincode 最近模型调用、缓存能力档案与模型池配置。',
      '用户问“raincode 状态 / 子代理工作状况 / 花了多少 token”时调用。',
      'Query recent model calls, cached capability profiles, and model-pool profiles.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {},
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
    async execute() {
      const base = normalizedBase(baseURL())
      try {
        const data = await fetchJson(`${base}/requests`)
        return { text: formatRequests(data) }
      } catch (requestError) {
        const requestMessage = requestError instanceof Error ? requestError.message : String(requestError)
        const warnings = [
          `recent requests unavailable: ${requestMessage} (the raincode gateway may not implement GET /requests yet; showing cached/model-pool info instead)`,
        ]
        const sections: string[] = []
        try {
          sections.push(formatProfiles(await fetchJson(`${base}/profiles`)))
        } catch (profileError) {
          warnings.push(`model-pool profiles unavailable: ${profileError instanceof Error ? profileError.message : String(profileError)}`)
        }
        try {
          sections.push(formatCapabilities(await fetchJson(`${base}/capabilities`)))
        } catch (capabilityError) {
          warnings.push(`cached capability profiles unavailable: ${capabilityError instanceof Error ? capabilityError.message : String(capabilityError)}`)
        }
        if (sections.length === 0) {
          return {
            text: [
              '# raincode status',
              '',
              'All status endpoints failed. Please check that the raincode gateway is running and reachable.',
              '',
              ...warnings,
            ].join('\n'),
          }
        }
        return {
          text: [
            '# raincode status',
            '',
            `> ${warnings[0]}`,
            ...(warnings.length > 1 ? ['> ' + warnings.slice(1).join('\n> ')] : []),
            '',
            ...sections.map((section) => section + '\n'),
          ].join('\n').trimEnd(),
        }
      }
    },
  })
}
