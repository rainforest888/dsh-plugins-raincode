import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  acquireGatewayManager,
  gatewayBin,
  isLoopbackBaseURL,
  pluginRegistryPath,
  readLiveConfig,
  volatileField,
} from '@raincode-dsh/core'
import { registerSkillsCommand } from './commands.js'
import { registerSkillTools } from './skill-tools.js'
import { registerLearnTool } from './learn.js'

export const name = 'raincode-skill'
export const inject = ['commands', 'tools']

const DEFAULT_BASE_URL = 'http://127.0.0.1:8787'

export interface Config {
  baseURL?: string
  spawnGateway?: boolean
  gatewayBin?: string
}

/**
 * 字段全部带 `.default(...)` + volatile，理由见 `@raincode-dsh/core` 的
 * `volatileField()`：dsh 0.1.7+ 的 settings 表单只收录 volatile 字段。
 */
export const Config: z<Config> = z.object({
  baseURL: volatileField(z.string().default(DEFAULT_BASE_URL)),
  spawnGateway: volatileField(z.boolean().default(true)),
  gatewayBin: volatileField(z.string().default('')),
})

export { isLoopbackBaseURL }

/**
 * 技能网络插件：`/skills` 命令 + 技能搜索/加载/沉淀工具。
 *
 * provider 适配器由 `dsh-plugins-raincode-routing` 独家注册（同一 profile 里两个
 * 插件都注册 `raincode` 会触发 llm 的重复 provider 校验），本插件只消费
 * gateway 的 HTTP 接口；两者一起安装时共享同一个 gateway 进程。
 */
export function apply(ctx: Context, rawConfig: Config): void {
  const config = (): Config => readLiveConfig(rawConfig)
  const baseURL = (): string => (config().baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, '')

  registerSkillsCommand(ctx, () => baseURL())

  ctx.inject(['tools'], (toolsCtx) => {
    const tools = (toolsCtx as unknown as { tools: { register: (def: unknown) => unknown } }).tools
    registerSkillTools({ tools }, () => baseURL())
    registerLearnTool({ tools }, () => baseURL())
  })

  const manager = acquireGatewayManager(ctx, baseURL(), gatewayBin(config().gatewayBin), pluginRegistryPath())
  ctx.effect(() => () => manager.release())
  if (config().spawnGateway ?? true) {
    void manager.ensure().catch((error) => ctx.logger.warn(`raincode: gateway unavailable: ${String((error as Error)?.message ?? error)}`))
  }
}
