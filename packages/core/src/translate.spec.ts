import { describe, it, expect } from 'vitest'
import { translate, mapUsage } from './translate.js'
import { EMPTY_RESPONSE_CODE, type StreamChunk } from '@deepseek-ai/dsh-llm'

async function run(payloads: string[]): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  const iterable: AsyncIterable<string> = (async function* () {
    for (const p of payloads) yield p
  })()
  for await (const chunk of translate(iterable)) out.push(chunk)
  return out
}

describe('translate', () => {
  it('maps deltas, reasoning, tool calls, usage, finish in contract order', async () => {
    const all = await run([
      JSON.stringify({ choices: [{ delta: { content: 'hi ' }, index: 0 }] }),
      JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking...' }, index: 0 }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"p":1}' } }] }, index: 0 }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } }),
      '[DONE]',
    ])
    expect(all.some((c) => c.type === 'text-delta' && (c as { text: string }).text === 'hi ')).toBe(true)
    expect(all.some((c) => c.type === 'reasoning-delta' && (c as { text: string }).text === 'thinking...')).toBe(true)
    const toolDelta = all.find((c) => c.type === 'tool-call-delta')
    expect(toolDelta).toMatchObject({ name: 'read', argumentsDelta: '{"p":1}' })
    // block-end 只在 [DONE] 后出现,且先于 usage/finish。
    const ends = all.filter((c) => c.type === 'block-end')
    expect(ends.some((c) => (c as { block: { type: string } }).block.type === 'tool-call')).toBe(true)
    expect(ends[ends.length - 1]).toMatchObject({ block: { type: 'tool-call', name: 'read', arguments: '{"p":1}' } })
    const usageIdx = all.findIndex((c) => c.type === 'usage')
    const finishIdx = all.findIndex((c) => c.type === 'finish')
    expect(usageIdx).toBeGreaterThan(-1)
    expect(finishIdx).toBeGreaterThan(usageIdx)
    expect(all[all.length - 1]).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(all.find((c) => c.type === 'usage')).toMatchObject({ usage: { inputTokens: 6, outputTokens: 2, cacheReadTokens: 4 } })
  })

  it('keeps parallel tool calls as separate blocks with per-index argument accumulation', async () => {
    const all = await run([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'read', arguments: '{"p":' } }] }, index: 0 }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'write', arguments: '{"q":' } }] }, index: 0 }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, index: 0 }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '2}' } }] }, index: 0 }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      '[DONE]',
    ])
    const ends = all.filter((c) => c.type === 'block-end').map((c) => (c as unknown as { block: Record<string, unknown> }).block)
    expect(ends).toHaveLength(2)
    expect(ends[0]).toMatchObject({ type: 'tool-call', id: 'call_a', name: 'read', arguments: '{"p":1}' })
    expect(ends[1]).toMatchObject({ type: 'tool-call', id: 'call_b', name: 'write', arguments: '{"q":2}' })
  })

  it('defers usage to [DONE] and handles trailing usage-only chunk after finish', async () => {
    const all = await run([
      JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }),
      JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 3, prompt_cache_hit_tokens: 5 } }),
      '[DONE]',
    ])
    expect(all[all.length - 2]).toMatchObject({ type: 'usage', usage: { inputTokens: 15, outputTokens: 3, cacheReadTokens: 5 } })
    expect(all[all.length - 1]).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('throws STREAM_CLOSED when [DONE] never arrives', async () => {
    await expect(run([
      JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }),
    ])).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })

  it('maps a stop with no content to an EMPTY_RESPONSE error finish', async () => {
    const all = await run([
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      '[DONE]',
    ])
    expect(all[all.length - 1]).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: EMPTY_RESPONSE_CODE } } })
  })

  it('throws MALFORMED_RESPONSE on invalid JSON payloads', async () => {
    await expect(run(['not json', '[DONE]'])).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('maps unknown finish reasons to an error finish with the uppercased code', async () => {
    const all = await run([
      JSON.stringify({ choices: [{ delta: { content: 'x' }, finish_reason: 'content_filter' }] }),
      '[DONE]',
    ])
    expect(all[all.length - 1]).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'CONTENT_FILTER' } } })
  })

  it('mapUsage includes reasoning tokens and subtracts cached reads', () => {
    const usage = mapUsage({
      prompt_tokens: 100,
      completion_tokens: 40,
      prompt_cache_hit_tokens: 30,
      prompt_tokens_details: { cached_tokens: 25 },
      completion_tokens_details: { reasoning_tokens: 38 },
    })
    // details.cached_tokens 优先于 prompt_cache_hit_tokens。
    expect(usage).toEqual({ inputTokens: 75, outputTokens: 40, cacheReadTokens: 25, reasoningTokens: 38 })
  })
})
