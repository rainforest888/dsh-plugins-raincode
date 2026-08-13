import { describe, it, expect } from 'vitest'
import { createTranslateState, translateChunk } from './translate.js'

describe('translateChunk', () => {
  it('maps deltas, reasoning, tool calls, usage, finish in order', () => {
    const state = createTranslateState()
    const chunks: Record<string, unknown>[] = [
      { choices: [{ delta: { content: 'hi ' }, index: 0 }] },
      { choices: [{ delta: { reasoning_content: 'thinking...' }, index: 0 }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"p":1}' } }] }, index: 0 }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } },
    ]
    const all = chunks.flatMap((c) => translateChunk(c, state))
    expect(all.some((c) => c.type === 'text-delta' && (c as { text: string }).text === 'hi ')).toBe(true)
    expect(all.some((c) => c.type === 'reasoning-delta' && (c as { text: string }).text === 'thinking...')).toBe(true)
    const toolDelta = all.find((c) => c.type === 'tool-call-delta')
    expect(toolDelta).toMatchObject({ id: 'call_1', name: 'read', argumentsDelta: '{"p":1}' })
    // 首个 block-end 是 text 块(reasoning 开始时被关闭),按块类型找 tool-call 的。
    const blockEnd = all.find((c) => c.type === 'block-end' && (c as { block: { type: string } }).block.type === 'tool-call')
    expect(blockEnd).toMatchObject({ block: { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"p":1}' } })
    const usageIdx = all.findIndex((c) => c.type === 'usage')
    const finishIdx = all.findIndex((c) => c.type === 'finish')
    expect(usageIdx).toBeGreaterThan(-1)
    expect(finishIdx).toBeGreaterThan(usageIdx)
    expect(all.find((c) => c.type === 'usage')).toMatchObject({ usage: { inputTokens: 6, outputTokens: 2, cacheReadTokens: 4 } })
    expect(all.find((c) => c.type === 'finish')).toMatchObject({ reason: { kind: 'tool-calls' } })
    expect(state.finished).toBe(true)
  })
})
