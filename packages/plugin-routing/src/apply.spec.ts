import { describe, expect, it } from 'vitest'
import { apply, Config, inject, name } from './index.js'
import type { Context } from '@deepseek-ai/cordis'
import { readLiveConfig } from '@raincode-dsh/core'

interface Entry {
  id: string
  options: { name: string; id: string }
}

function fakeCtx(entries: Entry[] = [{ id: 'dsh-plugins-raincode-routing', options: { name: 'dsh-plugins-raincode-routing', id: 'dsh-plugins-raincode-routing' } }]) {
  const calls = {
    providers: [] as Array<{ provider: string; settingsNs: string }>,
    adapters: [] as string[][],
    tools: [] as string[],
    events: [] as string[],
    effects: [] as Array<() => void>,
  }
  const ctx = {
    logger: { warn: () => {}, info: () => {}, debug: () => {} },
    get(name: string) {
      if (name === 'loader') return { entries: () => entries }
      return undefined
    },
    llm: {
      registerConfigurableProviders(list: Array<{ provider: string; settingsNs: string }>) {
        calls.providers.push(...list)
      },
      registerAdapter(providers: string[]) {
        calls.adapters.push(providers)
        return Object.assign(() => {}, { replace: () => {} })
      },
    },
    tools: { register(definition: { name: string }) { calls.tools.push(definition.name) } },
    commands: { register: () => {} },
    inject(_names: string[], callback: (scoped: unknown) => void) { callback(ctx) },
    on(event: string) { calls.events.push(event) },
    effect(factory: () => () => void) { calls.effects.push(factory()) },
  }
  return { ctx: ctx as unknown as Context, calls }
}

const config = {
  baseURL: 'http://127.0.0.1:8787',
  spawnGateway: false,
  gatewayBin: '',
  mainModel: 'deepseek-v4-pro',
  subagentProvider: 'spawn',
  maxDepth: 3,
  streamIdleTimeoutMs: 30_000,
}

describe('raincode routing plugin entry', () => {
  it('declares the dsh 0.2.x injection contract', () => {
    expect(name).toBe('raincode-routing')
    expect(inject).toEqual(['llm', 'commands', 'tools', 'subagents'])
  })

  it('registers the raincode provider under the loader entry id as its settings namespace', () => {
    const { ctx, calls } = fakeCtx()
    apply(ctx, config as never)
    expect(calls.providers).toEqual([
      expect.objectContaining({ provider: 'raincode', settingsNs: 'dsh-plugins-raincode-routing' }),
    ])
    expect(calls.adapters).toEqual([['raincode']])
  })

  it('registers route/agent-tree tools and the llm/stream interception', () => {
    const { ctx, calls } = fakeCtx()
    apply(ctx, config as never)
    expect(calls.tools).toEqual(expect.arrayContaining(['raincode_route', 'raincode_agent_tree']))
    expect(calls.events).toContain('llm/stream')
    expect(calls.effects).toHaveLength(1)
    expect(() => calls.effects[0]!()).not.toThrow()
  })

  it('falls back to the package name when the loader entry cannot be resolved', () => {
    const { ctx, calls } = fakeCtx([])
    apply(ctx, config as never)
    expect(calls.providers[0]?.settingsNs).toBe('dsh-plugins-raincode-routing')
  })

  it('exposes a config schema where every field is volatile and defaulted', () => {
    const dict = (Config as unknown as { dict: Record<string, { meta?: { volatile?: boolean; default?: unknown } }> }).dict
    expect(Object.keys(dict).length).toBeGreaterThan(0)
    for (const [field, schema] of Object.entries(dict)) {
      expect(schema.meta?.volatile, `${field} must be volatile`).toBe(true)
      // retryPolicy 是嵌套 union schema，projectForm 会保留其对象形态。
      expect('default' in (schema.meta ?? {}) || field === 'retryPolicy', `${field} must carry a default`).toBe(true)
    }
    // schemastery 把 volatile 字段解析成 cosmokit Volatile 活引用({ get() })：
    // 这正是 dsh 0.1.7+ 交给 apply() 的形态，插件必须按请求解包。
    const parsed = Config({}) as unknown as { baseURL: { get(): string }; spawnGateway: { get(): boolean } }
    expect(typeof parsed.baseURL.get).toBe('function')
    expect(readLiveConfig(parsed as never)).toMatchObject({ baseURL: 'http://127.0.0.1:8787', spawnGateway: true })
  })
})
