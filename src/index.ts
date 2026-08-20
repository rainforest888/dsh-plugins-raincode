import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import {
  assertUsableApiKey,
  LlmError,
  RetryPolicySchema,
  resolveRetryPolicy,
  type RetryPolicyConfig,
} from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { RaincodeAdapter, type RaincodeConnectionOptions } from './adapter.js'
import { registerSkillsCommand } from './commands.js'
import { registerCapabilityTools } from './tools.js'
import { registerStatusTools } from './status.js'
import { registerSkillTools } from './skill-tools.js'
import { registerLearnTool } from './learn.js'
import { registerRouteTools } from './route.js'
import { registerAgentTreeTool } from './agent-tree.js'
import {
  createGatewayManager,
  defaultProfileFor,
  gatewayBin,
  isLoopbackBaseURL,
  pluginRegistryPath,
  readDshCurrentModel,
  syncProfiles,
  writeRegistry,
  type RaincodeProfile,
} from './gateway.js'

export const name = 'raincode'
export const inject = ['llm', 'commands', 'tools', 'subagents']

const NS = settingsNamespace('raincode')
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

export const Config: z<Config> = z.object({
  baseURL: z.string().default(DEFAULT_BASE_URL),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  profiles: z.array(profileSchema).default([]),
  spawnGateway: z.boolean().default(true),
  gatewayBin: z.string().default(''),
  mainModel: z.string().default(''),
  subagentProvider: z.string().default('spawn'),
  maxDepth: z.natural().min(0).max(4).default(3),
  streamIdleTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
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

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: RaincodeConnectionOptions | undefined
  const options = (): RaincodeConnectionOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveConnection(raw)
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('raincode: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  const resolveApiKey = async (): Promise<string> => {
    const ref = credentialRef(current().apiKeyEnv ?? DEFAULT_API_KEY_ENV)
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
    { provider: PROVIDER, displayName: 'Raincode', settingsNs: NS, settingsPath: [] },
  ])
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  let registeredPolicy = options().retryPolicy
  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => { current = source },
    onChange: () => {
      const policy = options().retryPolicy
      if (deepEqualJson(policy, registeredPolicy)) return
      registration.replace([PROVIDER])
      registeredPolicy = policy
    },
  })
  registerSkillsCommand(ctx, () => options().baseURL)

  ctx.inject(['tools'], (toolsCtx) => {
    registerCapabilityTools(toolsCtx as unknown as { tools: { register: (def: unknown) => unknown } }, () => options().baseURL)
    registerStatusTools(toolsCtx as unknown as { tools: { register: (def: unknown) => unknown } }, () => options().baseURL)
    registerSkillTools(toolsCtx as unknown as { tools: { register: (def: unknown) => unknown } }, () => options().baseURL)
    registerLearnTool(toolsCtx as unknown as { tools: { register: (def: unknown) => unknown } }, () => options().baseURL)
  })

  const mainModel = (): string => {
    const configured = current().mainModel ?? ''
    if (configured !== '') return configured
    const mainProfile = (current().profiles ?? []).find((p) => p.role === 'main')
    if (mainProfile?.model !== undefined && mainProfile.model !== '') return mainProfile.model
    const dshModel = readDshCurrentModel(ctx)
    return dshModel?.model ?? ''
  }

  ctx.inject(['subagents', 'tools'], (routeCtx) => {
    const scoped = routeCtx as unknown as {
      subagents: {
        start: (provider: string, request: unknown) => Promise<{
          id: string
          result: Promise<{ output: Array<{ type?: string; text?: string }>; stopReason?: string }>
          dispose: () => Promise<void>
        }>
        listDescendants?: (rootSessionId: string, signal?: AbortSignal) => Promise<Array<{
          id?: string
          parentId?: string
          depth?: number
          label?: string
          mode?: string
          activity?: string
          hasChildren?: boolean
        }>>
      }
      tools: { register: (def: unknown) => unknown }
    }
    registerRouteTools(
      { tools: scoped.tools },
      () => ({
        mainModel: mainModel(),
        subagentProvider: current().subagentProvider ?? 'spawn',
        defaultMaxDepth: current().maxDepth ?? 3,
        subagents: scoped.subagents,
      }),
    )
    registerAgentTreeTool({ tools: scoped.tools }, () => ({ subagents: scoped.subagents }))
  })

  // ── 无感绑定:dsh 当前交互模型 = raincode chat 模型 ──────────────────────
  const baseURL = () => options().baseURL.replace(/\/+$/, '')
  const manager = createGatewayManager(ctx, baseURL(), gatewayBin(current().gatewayBin), pluginRegistryPath())
  ctx.effect(() => () => manager.killChild())

  const profiles = (): RaincodeProfile[] => {
    const configured = current().profiles ?? []
    const byId = new Map<string, RaincodeProfile>()
    for (const p of configured) byId.set(p.id, p)
    const currentModel = readDshCurrentModel(ctx)
    const fallback = defaultProfileFor(currentModel)
    if (fallback !== undefined && !byId.has(fallback.id)) {
      return [fallback, ...configured]
    }
    return configured
  }

  const ensureGatewayReady = async (): Promise<boolean> => {
    if (!(current().spawnGateway ?? true)) return false
    try {
      // 先落 registry 文件再 spawn,避免 gateway 启动时读到旧/空文件。
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

  // dsh 当前模型变化时,重新绑定 chat 模型。
  ctx.on('settings/updated', (ns: unknown) => {
    if (String(ns) === settingsNamespace('agent-default-model')) {
      lastSyncedProfiles = ''
      void sync().catch((error) => ctx.logger.warn(`raincode: profile sync failed: ${String(error)}`))
    }
  })

  // 接管 dsh 正在和用户交互的模型。仅接管普通对话请求;
  // compaction / session-title 等辅助调用继续走原 provider。
  ctx.on('llm/stream', (options, next) => {
    if (options.provider === PROVIDER) {
      // provider=raincode 的请求也必须先确保 gateway 已拉起
      // (否则 raincode_route 启动的主控/子代理第一次调用会直接 TRANSPORT)。
      return (async function* () {
        try {
          await sync()
        } catch (error) {
          ctx.logger.warn(`raincode: gateway prepare failed: ${String((error as Error)?.message ?? error)}`)
        }
        yield * next()
      })()
    }
    if (options.purpose !== undefined) return next()
    return (async function* () {
      try {
        await sync()
        const known = new Set(profiles().map((p) => p.model))
        if (!known.has(options.model)) return yield * next()
        yield * adapter.stream(options)
      } catch (error) {
        ctx.logger.warn(`raincode: falling back to original provider: ${String((error as Error)?.message ?? error)}`)
        yield * next()
      }
    })()
  })
}
