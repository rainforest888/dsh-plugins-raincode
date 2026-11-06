import { describe, expect, it } from 'vitest'
import { apply, Config, inject, name } from './index.js'
import type { Context } from '@deepseek-ai/cordis'
import { readLiveConfig } from '@raincode-dsh/core'

function fakeCtx() {
  const calls = {
    tools: [] as string[],
    commands: [] as string[],
    effects: [] as Array<() => void>,
  }
  const ctx = {
    logger: { warn: () => {}, info: () => {}, debug: () => {} },
    tools: { register(definition: { name: string }) { calls.tools.push(definition.name) } },
    commands: { register(definition: { name: string }) { calls.commands.push(definition.name) } },
    inject(_names: string[], callback: (scoped: unknown) => void) { callback(ctx) },
    effect(factory: () => () => void) { calls.effects.push(factory()) },
    get() { return undefined },
  }
  return { ctx: ctx as unknown as Context, calls }
}

const config = { baseURL: 'http://127.0.0.1:8787', spawnGateway: false, gatewayBin: '' }

describe('raincode skill plugin entry', () => {
  it('declares the dsh 0.2.x injection contract', () => {
    expect(name).toBe('raincode-skill')
    expect(inject).toEqual(['commands', 'tools'])
  })

  it('registers the /skills command and the skill tools without claiming the llm provider', () => {
    const { ctx, calls } = fakeCtx()
    expect(() => apply(ctx, config as never)).not.toThrow()
    expect(calls.commands).toEqual(['skills'])
    expect(calls.tools).toEqual(
      expect.arrayContaining(['raincode_skill_search', 'raincode_skill_load', 'raincode_learn']),
    )
    expect(calls.effects).toHaveLength(1)
    expect(() => calls.effects[0]!()).not.toThrow()
  })

  it('exposes a volatile, defaulted config schema', () => {
    const dict = (Config as unknown as { dict: Record<string, { meta?: { volatile?: boolean } }> }).dict
    for (const [field, schema] of Object.entries(dict)) {
      expect(schema.meta?.volatile, `${field} must be volatile`).toBe(true)
    }
    // volatile 字段解析后是 cosmokit Volatile 活引用，插件用 readLiveConfig 解包。
    const parsed = Config({}) as unknown as { baseURL: { get(): string } }
    expect(typeof parsed.baseURL.get).toBe('function')
    expect(readLiveConfig(parsed as never)).toMatchObject({ baseURL: 'http://127.0.0.1:8787', spawnGateway: true })
  })
})
