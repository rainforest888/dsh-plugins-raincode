import { EMPTY_RESPONSE_CODE, LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'

/** Map the wire finish_reason vocabulary to the harness FinishReason. */
export function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    default: return { kind: 'error', failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() } }
  }
}

/**
 * Map wire usage fields. DeepSeek-style `prompt_tokens` INCLUDES cache hits
 * (`prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens`); the
 * harness TokenUsage convention is DISJOINT counts, so cache reads are
 * subtracted out of `inputTokens`.
 */
export function mapUsage(usage: Record<string, unknown>): TokenUsage {
  const prompt = typeof usage['prompt_tokens'] === 'number' ? usage['prompt_tokens'] as number : 0
  const completion = typeof usage['completion_tokens'] === 'number' ? usage['completion_tokens'] as number : 0
  const details = (usage['prompt_tokens_details'] ?? {}) as Record<string, unknown>
  const completionDetails = (usage['completion_tokens_details'] ?? {}) as Record<string, unknown>
  const cacheRead = typeof details['cached_tokens'] === 'number'
    ? details['cached_tokens'] as number
    : typeof usage['prompt_cache_hit_tokens'] === 'number'
      ? usage['prompt_cache_hit_tokens'] as number
      : undefined
  const reasoning = typeof completionDetails['reasoning_tokens'] === 'number'
    ? completionDetails['reasoning_tokens'] as number
    : undefined
  const out: TokenUsage = {
    inputTokens: prompt - (cacheRead ?? 0),
    outputTokens: completion,
  }
  if (cacheRead !== undefined) out.cacheReadTokens = cacheRead
  if (reasoning !== undefined) out.reasoningTokens = reasoning
  return out
}

interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  callId?: string
  name?: string
}

function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    default: return {
      type: 'tool-call',
      id: ToolCallId(block.callId ?? ''),
      name: block.name ?? '',
      arguments: block.text,
    }
  }
}

/**
 * Consume SSE data payloads (ending with the `[DONE]` sentinel) and yield
 * StreamChunks. One stateful harness block per content, reasoning, or tool
 * call index: parallel tool calls stay separate blocks and fragmented
 * arguments accumulate per call index. `block-end`s, `usage`, and `finish`
 * are all deferred to the `[DONE]` sentinel, so usage always precedes finish
 * and nothing follows finish. A `stop` (or absent) finish with no opened
 * blocks is a degenerate provider completion and maps to an `EMPTY_RESPONSE`
 * error finish instead of a successful empty message. Malformed JSON payloads
 * abort the stream with `MALFORMED_RESPONSE`; a payload stream ending without
 * `[DONE]` throws `STREAM_CLOSED`.
 */
export async function* translate(payloads: AsyncIterable<string>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let textBlock: OpenBlock | undefined
  let reasoningBlock: OpenBlock | undefined
  const toolBlocks = new Map<number, OpenBlock>()
  const order: OpenBlock[] = []
  let pendingFinish: FinishReason | undefined
  let pendingUsage: TokenUsage | undefined
  const open = (kind: OpenBlock['kind']): OpenBlock => {
    const block: OpenBlock = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }
  for await (const payload of payloads) {
    if (payload === '[DONE]') {
      for (const block of order) {
        yield { type: 'block-end', index: block.index, block: closeBlock(block) }
      }
      if (pendingUsage !== undefined) yield { type: 'usage', usage: pendingUsage }
      const reason = pendingFinish ?? { kind: 'stop' as const }
      yield {
        type: 'finish',
        reason: reason.kind === 'stop' && order.length === 0
          ? {
              kind: 'error' as const,
              failure: {
                message: 'model returned a completed response with no content',
                code: EMPTY_RESPONSE_CODE,
              },
            }
          : reason,
      }
      return
    }
    let chunk: Record<string, unknown>
    try {
      chunk = JSON.parse(payload) as Record<string, unknown>
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE')
    }
    const choices = Array.isArray(chunk['choices']) ? chunk['choices'] as Array<Record<string, unknown>> : []
    for (const choice of choices) {
      const delta = (choice['delta'] ?? {}) as Record<string, unknown>
      const reasoning = typeof delta['reasoning_content'] === 'string' ? delta['reasoning_content'] : ''
      if (reasoning.length > 0) {
        if (reasoningBlock === undefined) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += reasoning
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
      }
      const content = typeof delta['content'] === 'string' ? delta['content'] : ''
      if (content.length > 0) {
        if (textBlock === undefined) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += content
        yield { type: 'text-delta', index: textBlock.index, text: content }
      }
      const toolCalls = Array.isArray(delta['tool_calls']) ? delta['tool_calls'] as Array<Record<string, unknown>> : []
      for (const call of toolCalls) {
        const wireIndex = typeof call['index'] === 'number' ? call['index'] as number : -1
        let block = wireIndex >= 0 ? toolBlocks.get(wireIndex) : undefined
        if (block === undefined) {
          block = open('tool-call')
          if (wireIndex >= 0) toolBlocks.set(wireIndex, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        if (typeof call['id'] === 'string' && call['id'] !== '') block.callId = call['id']
        const fn = (call['function'] ?? {}) as Record<string, unknown>
        if (typeof fn['name'] === 'string' && fn['name'] !== '') block.name = fn['name']
        const fragment = typeof fn['arguments'] === 'string' ? fn['arguments'] : ''
        block.text += fragment
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: ToolCallId(block.callId ?? ''),
          ...(block.name !== undefined ? { name: block.name } : {}),
          argumentsDelta: fragment,
        }
      }
      const finishReason = choice['finish_reason']
      if (typeof finishReason === 'string' && finishReason !== '') pendingFinish = mapFinishReason(finishReason)
    }
    if (chunk['usage'] !== undefined && chunk['usage'] !== null) {
      pendingUsage = mapUsage(chunk['usage'] as Record<string, unknown>)
    }
  }
  throw new LlmError('SSE payload stream ended without [DONE]', 'STREAM_CLOSED')
}
