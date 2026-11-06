/**
 * raincode_route:用 dsh 原生 subagent seam 运行 raincode 主控模型。
 *
 * chat 模型判断任务足够复杂或用户明确要求后调用本工具;
 * 本工具启动一个 one-shot 子代理,该子代理使用 raincode 主控模型
 * (provider=raincode, model=mainModel),并继承 dsh 的 subagent 工具,
 * 由主控模型自己继续拆解、派发子代理/孙代理。
 */

interface SubagentActivationLike {
  childId: string
  result: Promise<{
    output: Array<{ type?: string; text?: string }>
    stopReason?: string
  }>
  dispose: () => Promise<void>
}

export interface RouteToolDeps {
  mainModel: string
  subagentProvider: string
  defaultMaxDepth: number
  subagents: {
    /** dsh 0.2.x seam：`startActivation(spec)` 取代了旧 `start(provider, request)`。 */
    startActivation: (spec: {
      provider: string
      label?: string
      request: {
        prompt: Array<{ type: 'text'; text: string }>
        parent: unknown
        signal?: AbortSignal
        agentOptions?: { provider?: string; model?: string; maxTokens?: number }
        maxDepth?: number
      }
      signal?: AbortSignal
      delivery?: 'parent' | 'caller'
    }) => Promise<SubagentActivationLike>
  }
}

interface RouteArgs {
  prompt?: string
  maxDepth?: number
}

export function registerRouteTools(
  ctx: { tools: { register: (def: unknown) => unknown } },
  deps: () => RouteToolDeps,
): void {
  ctx.tools.register({
    name: 'raincode_route',
    description: [
      'Run a large task through the raincode orchestrator: a strong main model decomposes the task',
      'and dispatches cheaper subagent models by direction (frontend/backend/testing/...).',
      '',
      'Call this tool ONLY when:',
      '1. the user explicitly asks to use raincode / route / orchestrate, or',
      '2. the task is clearly large: multi-module, multi-direction, long-running, or requires several subagents.',
      '',
      'Do NOT call it for small tasks (e.g. a simple calculator) — decomposition costs more than it saves.',
      'When in doubt, ask the user whether to start raincode route.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The complete task description for the orchestrator' },
        maxDepth: { type: 'integer', minimum: 0, maximum: 4, description: 'Maximum subagent delegation depth (default from plugin config)' },
      },
      required: ['prompt'],
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
    async execute(args: RouteArgs, exec?: { agent?: unknown; signal?: AbortSignal }) {
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
      if (prompt === '') return { text: 'raincode_route: `prompt` is required.' }
      const cfg = deps()
      if (cfg.mainModel === '') {
        return { text: 'raincode_route: no main model configured. Add a profile with role=main in raincode settings, or set mainModel.' }
      }
      if (exec?.agent === undefined) return { text: 'raincode_route: no parent agent context available.' }
      const maxDepth = typeof args.maxDepth === 'number' ? Math.max(0, Math.min(4, Math.floor(args.maxDepth))) : cfg.defaultMaxDepth
      const signal = exec?.signal ?? new AbortController().signal
      let run: SubagentActivationLike
      try {
        run = await cfg.subagents.startActivation({
          provider: cfg.subagentProvider,
          label: 'raincode route',
          request: {
            prompt: [{ type: 'text', text: prompt }],
            parent: exec.agent,
            signal,
            agentOptions: { provider: 'raincode', model: cfg.mainModel },
            maxDepth,
          },
          signal,
          delivery: 'caller',
        })
      } catch (error) {
        return { text: `raincode_route failed to start subagent: ${String((error as Error)?.message ?? error)}` }
      }
      try {
        const result = await run.result
        const text = result.output
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('\n')
        const ok = result.stopReason === 'completed'
        return { text: ok ? text || '(no output)' : `raincode_route stopped with ${result.stopReason ?? 'error'}\n${text}` }
      } catch (error) {
        return { text: `raincode_route failed: ${String((error as Error)?.message ?? error)}` }
      } finally {
        await run.dispose().catch(() => {})
      }
    },
  })
}
