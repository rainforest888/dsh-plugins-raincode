import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

/** One raincode model-pool profile, as edited in the dsh plugin settings UI. */
export interface RaincodeProfile {
  id: string
  name?: string
  kind?: string
  baseURL?: string
  model: string
  apiKey?: string
  apiKeyEnv?: string
  apiKeyFile?: string
  role?: 'main' | 'subagent' | 'any'
  tags?: string[]
}

/** dsh 内置 provider → raincode profile 的最小推导表。 */
const BUILTIN_PROVIDERS: Record<string, { baseURL: string; apiKeyEnv: string }> = {
  'deepseek-official': { baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' },
}

const HEALTH_TIMEOUT_MS = 15_000
const HEALTH_INTERVAL_MS = 250

export function isLoopbackBaseURL(baseURL: string): boolean {
  try {
    const host = new URL(baseURL).hostname.toLowerCase()
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

/** 用户未配置 `gatewayBin` 时,按 RAINCODE_BIN → PATH 里的 `raincode` 查找。 */
export function gatewayBin(configured: string | undefined): string {
  if (configured !== undefined && configured.length > 0) return configured
  return process.env.RAINCODE_BIN ?? 'raincode'
}

/** 插件专用 registry 文件路径(避免污染用户默认 ~/.raincode/profiles.toml)。 */
export function pluginRegistryPath(): string {
  return join(tmpdir(), 'raincode-dsh', 'profiles.toml')
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

/** 生成极简 TOML registry,供 `raincode proxy --registry-path` 启动使用。 */
export function writeRegistry(path: string, profiles: RaincodeProfile[]): Promise<void> {
  const lines: string[] = []
  for (const p of profiles) {
    lines.push('[[profiles]]')
    lines.push(`id = ${tomlString(p.id)}`)
    lines.push(`name = ${tomlString(p.name ?? p.id)}`)
    lines.push(`kind = ${tomlString(p.kind ?? 'openai-compat')}`)
    lines.push(`base_url = ${tomlString(p.baseURL ?? '')}`)
    lines.push(`model = ${tomlString(p.model)}`)
    if (p.apiKey !== undefined && p.apiKey.length > 0) lines.push(`api_key = ${tomlString(p.apiKey)}`)
    if (p.apiKeyEnv !== undefined && p.apiKeyEnv.length > 0) lines.push(`api_key_env = ${tomlString(p.apiKeyEnv)}`)
    if (p.apiKeyFile !== undefined && p.apiKeyFile.length > 0) lines.push(`api_key_file = ${tomlString(p.apiKeyFile)}`)
    lines.push('')
  }
  if (profiles.length > 0) {
    lines.push(`active_id = ${tomlString(profiles[0].id)}`)
  } else {
    // 空 registry 也必须是合法 TOML(Registry::load 会解析文件)。
    lines.push('profiles = []')
  }
  return writeFile(path, lines.join('\n'))
}

/** 读取 dsh 当前正在和用户交互的模型。 */
export function readDshCurrentModel(ctx: Context): { provider: string; model: string } | undefined {
  try {
    const ns = settingsNamespace('agent-default-model')
    const value = ctx.settings?.get(ns) as { provider?: string; model?: string } | undefined
    if (value === undefined || value.model === undefined || value.model.length === 0) return undefined
    return { provider: value.provider ?? 'deepseek-official', model: value.model }
  } catch {
    return undefined
  }
}

/** 从 dsh 当前模型推导一个默认 raincode profile;推导不出返回 undefined。 */
export function defaultProfileFor(current: { provider: string; model: string } | undefined): RaincodeProfile | undefined {
  if (current === undefined) return undefined
  const builtin = BUILTIN_PROVIDERS[current.provider]
  if (builtin === undefined) return undefined
  return {
    id: current.model,
    name: current.model,
    kind: 'openai-compat',
    baseURL: builtin.baseURL,
    model: current.model,
    apiKeyEnv: builtin.apiKeyEnv,
  }
}

async function isUp(baseURL: string): Promise<boolean> {
  try {
    const resp = await fetch(`${baseURL.replace(/\/+$/, '')}/health`, { cache: 'no-store' })
    return resp.ok
  } catch {
    return false
  }
}

async function waitForHealth(baseURL: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await isUp(baseURL)) return
    if (Date.now() > deadline) throw new Error(`raincode gateway did not become healthy at ${baseURL} within ${timeoutMs}ms`)
    await new Promise((resolve) => setTimeout(resolve, HEALTH_INTERVAL_MS))
  }
}

/** 把 profiles 全量同步给运行中的 gateway。 */
export async function syncProfiles(baseURL: string, profiles: RaincodeProfile[]): Promise<void> {
  const resp = await fetch(`${baseURL.replace(/\/+$/, '')}/profiles`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profiles }),
  })
  if (!resp.ok) throw new Error(`raincode gateway /profiles sync failed (HTTP ${resp.status})`)
}

/** Gateway 生命周期管理器:按需 spawn、health check、dispose 时杀掉。 */
export function createGatewayManager(ctx: Context, baseURL: string, bin: string, registryPath: string) {
  let child: ChildProcess | undefined
  let ensurePromise: Promise<void> | undefined

  const killChild = (): void => {
    if (child !== undefined && child.exitCode === null) {
      child.kill()
    }
    child = undefined
  }

  const ensure = async (): Promise<void> => {
    if (isLoopbackBaseURL(baseURL) && await isUp(baseURL)) return
    if (ensurePromise !== undefined) return ensurePromise
    ensurePromise = (async () => {
      if (isLoopbackBaseURL(baseURL) && await isUp(baseURL)) return
      const port = new URL(baseURL).port || '8787'
      ctx.logger.info(`raincode: starting gateway at ${baseURL} (${bin})`)
      const spawned = spawn(bin, ['proxy', '--port', port, '--registry-path', registryPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
        windowsHide: true,
      })
      child = spawned
      // 等 OS 确认子进程启动(ENOENT/权限错误在此显式拒绝),避免 health 轮询掩盖 spawn 失败。
      await new Promise<void>((resolve, reject) => {
        spawned.once('spawn', () => resolve())
        spawned.once('error', (error) => {
          child = undefined
          reject(error)
        })
      })
      spawned.stdout?.on('data', () => {})
      spawned.stderr?.on('data', (chunk: Buffer) => {
        ctx.logger.warn(`raincode gateway: ${chunk.toString().trim()}`)
      })
      spawned.on('exit', (code) => {
        ctx.logger.info(`raincode: gateway exited (${code ?? 'signal'})`)
        child = undefined
      })
      await waitForHealth(baseURL, HEALTH_TIMEOUT_MS)
    })()
    try {
      await ensurePromise
    } finally {
      ensurePromise = undefined
    }
  }

  return { ensure, killChild }
}
