import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { LlmError, RetryPolicySchema, type RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { RaincodeAdapter, type RaincodeConnectionOptions, type RaincodeModel } from './adapter.js'
import { registerSkillsCommand } from './commands.js'

export const name = 'raincode'
export const inject = ['llm', 'commands']

const NS = settingsNamespace('raincode')
const PROVIDER = 'raincode'
const DEFAULT_BASE_URL = 'http://127.0.0.1:8787'
const DEFAULT_API_KEY_ENV = 'RAINCODE_API_KEY'

export interface Config {
  baseURL?: string
  apiKeyEnv?: string
  models?: RaincodeModel[]
  streamIdleTimeoutMs?: number
  retryPolicy?: RetryPolicyConfig
}

const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
})

export const Config: z<Config> = z.object({
  baseURL: z.string().default(DEFAULT_BASE_URL),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  models: z.array(catalogModel).default([]),
  streamIdleTimeoutMs: z.number().min(1).default(300_000),
  retryPolicy: RetryPolicySchema,
})

function resolveConnection(config: Config): RaincodeConnectionOptions {
  return {
    baseURL: config.baseURL ?? DEFAULT_BASE_URL,
    models: config.models ?? [],
    streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? 300_000,
  }
}

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: RaincodeConnectionOptions | undefined
  const options = (): RaincodeConnectionOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    const next = resolveConnection(raw)
    lastRaw = raw
    lastGood = next
    return next
  }
  options()

  const resolveApiKey = async (): Promise<string> => {
    const ref = credentialRef(current().apiKeyEnv ?? DEFAULT_API_KEY_ENV)
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return hit.value
    } else {
      const ambient = launchEnvironmentOf(ctx).get(ref)
      if (ambient !== undefined && ambient.value.length > 0) return ambient.value
    }
    // 本地 gateway 不校验 key;这里只满足 dsh 凭据接缝。仍给出可操作报错。
    throw new LlmError(
      `raincode: no API key for provider "${PROVIDER}"; export ${ref} (the local gateway ignores it)`,
      'MISSING_CREDENTIAL',
    )
  }

  const adapter = new RaincodeAdapter({ options, resolveApiKey })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'Raincode', settingsNs: NS, settingsPath: [] },
  ])
  ctx.llm.registerAdapter([PROVIDER], adapter)
  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => { current = source },
    onChange: () => {},
  })
  registerSkillsCommand(ctx, () => options().baseURL)
}
