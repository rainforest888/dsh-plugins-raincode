import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
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
  createGatewayManager,
  isLoopbackBaseURL,
  pluginRegistryPath,
  RaincodeAdapter,
  type RaincodeConnectionOptions,
} from '@raincode-dsh/core'
import { registerSkillsCommand } from './commands.js'
import { registerSkillTools } from './skill-tools.js'
import { registerLearnTool } from './learn.js'

export const name = 'raincode-skill'
export const inject = ['llm', 'commands', 'tools']

const NS = settingsNamespace('raincode-skill')
const PROVIDER = 'raincode'
const DEFAULT_BASE_URL = 'http://127.0.0.1:8787'
const DEFAULT_API_KEY_ENV = 'RAINCODE_API_KEY'
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

export interface Config {
  baseURL?: string
  apiKeyEnv?: string
  spawnGateway?: boolean
  gatewayBin?: string
  streamIdleTimeoutMs?: number
  retryPolicy?: RetryPolicyConfig
}

export const Config: z<Config> = z.object({
  baseURL: z.string().default(DEFAULT_BASE_URL),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  spawnGateway: z.boolean().default(true),
  gatewayBin: z.string().default(''),
  streamIdleTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
})

function resolveConnection(config: Config): RaincodeConnectionOptions {
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  return {
    baseURL: config.baseURL ?? DEFAULT_BASE_URL,
    models: [],
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'raincode: retryPolicy'),
  }
}

export { isLoopbackBaseURL }

export function apply(ctx: Context, config: Config): void {
  const options = (): RaincodeConnectionOptions => resolveConnection(config)

  const resolveApiKey = async (): Promise<string> => {
    const ref = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV)
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
    { provider: PROVIDER, displayName: 'Raincode (skill)', settingsNs: NS, settingsPath: [] },
  ])
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => { config = source() },
    onChange: () => registration.replace([PROVIDER]),
  })
  registerSkillsCommand(ctx, () => options().baseURL)

  ctx.inject(['tools'], (toolsCtx) => {
    const tools = (toolsCtx as unknown as { tools: { register: (def: unknown) => unknown } }).tools
    registerSkillTools({ tools }, () => options().baseURL)
    registerLearnTool({ tools }, () => options().baseURL)
  })

  const baseURL = () => options().baseURL.replace(/\/+$/, '')
  const manager = createGatewayManager(ctx, baseURL(), (config.gatewayBin ?? process.env.RAINCODE_BIN ?? 'raincode'), pluginRegistryPath())
  ctx.effect(() => () => manager.killChild())
  if (config.spawnGateway ?? true) {
    void manager.ensure().catch((error) => ctx.logger.warn(`raincode: gateway unavailable: ${String((error as Error)?.message ?? error)}`))
  }
}