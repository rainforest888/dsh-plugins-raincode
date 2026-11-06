import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import {
  assertUsableApiKey,
  LlmError,
  RetryPolicySchema,
  resolveRetryPolicy,
  type RetryPolicyConfig,
} from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  acquireGatewayManager,
  defaultProfileFor,
  gatewayBin,
  isLoopbackBaseURL,
  pluginRegistryPath,
  readDshCurrentModel,
  readLiveConfig,
  resolveSettingsNamespace,
  syncProfiles,
  volatileField,
  writeRegistry,
  RaincodeAdapter,
  type RaincodeConnectionOptions,
  type RaincodeProfile,
} from '@raincode-dsh/core'
import { registerRouteTools } from './route.js'
import { registerAgentTreeTool } from './agent-tree.js'
import { registerCapabilityTools } from './tools.js'
import { registerStatusTools } from './status.js'

export const name = 'raincode-routing'
export const inject = ['llm', 'commands', 'tools', 'subagents']

/** npm 包名；loader 条目 id 通常与它相同，但也可能是 `include:<pkg>` 之类的形式。 */
const PACKAGE_NAME = 'dsh-plugins-raincode-routing'
const PROVIDER = 'raincode'
const DEFAULT_BASE_URL = 'http://127.0.0.1:8787'
const DEFAULT_API_KEY_ENV = 'RAINCODE_API_KEY'
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

export interface Config {
  baseURL?: string
  apiKeyEnv?: string
  profiles?: RaincodeProfile[]
  spawnGateway?: boolean
  gatewayBin?: string
  mainModel?: string
  subagentProvider?: string
  maxDepth?: number
  streamIdleTimeoutMs?: number
  retryPolicy?: RetryPolicyConfig
}

const profileSchema = z.object({
  id: z.string().required(),
  name: z.string(),
  kind: z.string().default('openai-compat'),
  baseURL: z.string().default(''),
  model: z.string().required(),
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref'),
  apiKeyFile: z.string(),
  role: z.union([z.const('main'), z.const('subagent'), z.const('any')]).default('any'),
  tags: z.array(z.string()).default([]),
})

/**
 * 每个字段都带 `.default(...)` 且标记 volatile：dsh 0.1.7+ 会把它们投影成
 * 可热更新的设置表单（`SettingsForms.describe()` 只收录含 volatile 字段的
 * 条目），插件侧用 `readLiveConfig()` 每次读取最新值，无需重挂载。
 */
export const Config: z<Config> = z.object({
  baseURL: volatileField(z.string().default(DEFAULT_BASE_URL)),
  apiKeyEnv: volatileField(z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV)),
  profiles: volatileField(z.array(profileSchema).default([])),
  spawnGateway: volatileField(z.boolean().default(true)),
  gatewayBin: volatileField(z.string().default('')),
  mainModel: volatileField(z.string().default('')),
  subagentProvider: volatileField(z.string().default('spawn')),
  maxDepth: volatileField(z.natural().min(0).max(4).default(3)),
  streamIdleTimeoutMs: volatileField(
    z.number().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  ),
  retryPolicy: volatileField(RetryPolicySchema),
})

function resolveConnection(config: Config): RaincodeConnectionOptions {
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`raincode: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  return {
    baseURL: config.baseURL ?? DEFAULT_BASE_URL,
    models: [],
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'raincode: retryPolicy'),
  }
}

export { isLoopbackBaseURL }

export function apply(ctx: Context, rawConfig: Config): void {
  /** 每次调用都重新解包 live config，settings 写入后立即生效。 */
  const config = (): Config => readLiveConfig(rawConfig)
  const NS = resolveSettingsNamespace(ctx, PACKAGE_NAME)
  const baseURL = (): string => resolveConnection(config()).baseURL.replace(/\/+$/, '')
  const options = (): RaincodeConnectionOptions => resolveConnection(config())

  const resolveApiKey = async (): Promise<string> => {
    const ref = credentialRef(config().apiKeyEnv ?? DEFAULT_API_KEY_ENV)
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'raincode', ref)
    } else {
      const ambient = launchEnvironmentOf(ctx).get(ref)
      if (ambient !== undefined && ambient.value.length > 0) {
        return assertUsableApiKey(ambient.value, 'raincode', ref)
      }
    }
    if (isLoopbackBaseURL(options().baseURL)) return 'raincode-local'
    throw new LlmError(
      `raincode: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials service, or export ${ref} in the launching environment (a local loopback gateway does not need one)`,
      'MISSING_CREDENTIAL',
    )
  }

  const adapter = new RaincodeAdapter({ options, resolveApiKey })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'Raincode (routing)', settingsNs: NS, settingsPath: [] },
  ])
  // 路由策略由 adapter 在每次请求时读取 live config，因此设置变化无需 replace()。
  ctx.llm.registerAdapter([PROVIDER], adapter)

  ctx.inject(['tools'], (toolsCtx) => {
    const tools = (toolsCtx as unknown as { tools: { register: (def: unknown) => unknown } }).tools
    registerCapabilityTools({ tools }, () => baseURL())
    registerStatusTools({ tools }, () => baseURL())
  })

  const mainModel = (): string => {
    const live = config()
    const configured = live.mainModel ?? ''
    if (configured !== '') return configured
    const mainProfile = (live.profiles ?? []).find((p) => p.role === 'main')
    if (mainProfile?.model !== undefined && mainProfile.model !== '') return mainProfile.model
    const dshModel = readDshCurrentModel(ctx)
    return dshModel?.model ?? ''
  }

  ctx.inject(['subagents', 'tools'], (routeCtx) => {
    const scoped = routeCtx as unknown as {
      subagents: {
        startActivation: (spec: unknown) => Promise<{
          childId: string
          result: Promise<{ output: Array<{ type?: string; text?: string }>; stopReason?: string }>
          dispose: () => Promise<void>
        }>
        listDescendants?: (rootSessionId: string, signal?: AbortSignal) => Promise<Array<{
          id?: string; parentId?: string; depth?: number; label?: string
          mode?: string; activity?: string; hasChildren?: boolean
        }>>
      }
      tools: { register: (def: unknown) => unknown }
    }
    registerRouteTools(
      { tools: scoped.tools },
      () => ({
        mainModel: mainModel(),
        subagentProvider: config().subagentProvider ?? 'spawn',
        defaultMaxDepth: config().maxDepth ?? 3,
        subagents: scoped.subagents,
      }),
    )
    registerAgentTreeTool({ tools: scoped.tools }, () => ({ subagents: scoped.subagents }))
  })

  // gateway 自动拉起（与 skill 插件共享同一进程）+ registry 同步 + 接管 dsh chat 模型。
  const manager = acquireGatewayManager(ctx, baseURL(), gatewayBin(config().gatewayBin), pluginRegistryPath())
  ctx.effect(() => () => manager.release())

  const profiles = (): RaincodeProfile[] => {
    const configured = config().profiles ?? []
    const byId = new Map<string, RaincodeProfile>()
    for (const p of configured) byId.set(p.id, p)
    const currentModel = readDshCurrentModel(ctx)
    const fallback = defaultProfileFor(currentModel)
    if (fallback !== undefined && !byId.has(fallback.id)) return [fallback, ...configured]
    return configured
  }

  const ensureGatewayReady = async (): Promise<boolean> => {
    if (!(config().spawnGateway ?? true)) return false
    try {
      await writeRegistry(pluginRegistryPath(), profiles())
      await manager.ensure()
      return true
    } catch (error) {
      ctx.logger.warn(`raincode: gateway unavailable: ${String((error as Error)?.message ?? error)}`)
      return false
    }
  }

  let lastSyncedProfiles = ''
  const sync = async (): Promise<void> => {
    const list = profiles()
    const key = JSON.stringify(list)
    if (key === lastSyncedProfiles) return
    if (!(await ensureGatewayReady())) return
    await syncProfiles(baseURL(), list)
    lastSyncedProfiles = key
  }

  ctx.on('llm/stream', (streamOptions, next) => {
    if (streamOptions.provider === PROVIDER) {
      return (async function* () {
        try { await sync() } catch (error) {
          ctx.logger.warn(`raincode: gateway prepare failed: ${String((error as Error)?.message ?? error)}`)
        }
        yield * next()
      })()
    }
    if (streamOptions.purpose !== undefined) return next()
    return (async function* () {
      try {
        await sync()
        const known = new Set(profiles().map((p) => p.model))
        if (!known.has(streamOptions.model)) return yield * next()
        yield * adapter.stream(streamOptions)
      } catch (error) {
        ctx.logger.warn(`raincode: falling back to original provider: ${String((error as Error)?.message ?? error)}`)
        yield * next()
      }
    })()
  })
}
