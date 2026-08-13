import type { FinishReason, StreamChunk } from '@deepseek-ai/dsh-llm'

export interface TranslateState {
  openIndex: number
  openType: 'text' | 'reasoning' | 'tool-call' | null
  openText: string
  openReasoning: string
  openToolId: string
  openToolName: string
  openToolArgs: string
  finished: boolean
  nextIndex: number
}

export function createTranslateState(): TranslateState {
  return { openIndex: -1, openType: null, openText: '', openReasoning: '', openToolId: '', openToolName: '', openToolArgs: '', finished: false, nextIndex: 0 }
}

function closeBlock(state: TranslateState, out: StreamChunk[]): void {
  if (state.openType === null) return
  const index = state.openIndex
  if (state.openType === 'text') {
    out.push({ type: 'block-end', index, block: { type: 'text', text: state.openText } })
  } else if (state.openType === 'reasoning') {
    out.push({ type: 'block-end', index, block: { type: 'reasoning', text: state.openReasoning } })
  } else {
    out.push({ type: 'block-end', index, block: { type: 'tool-call', id: state.openToolId, name: state.openToolName, arguments: state.openToolArgs } })
  }
  state.openType = null
  state.openIndex = -1
}

function beginBlock(state: TranslateState, out: StreamChunk[], type: 'text' | 'reasoning' | 'tool-call'): number {
  if (state.openType !== null && state.openType !== type) closeBlock(state, out)
  if (state.openType === type) return state.openIndex
  const index = state.nextIndex++
  state.openIndex = index
  state.openType = type
  state.openText = ''
  state.openReasoning = ''
  state.openToolId = ''
  state.openToolName = ''
  state.openToolArgs = ''
  out.push({ type: 'block-start', index, blockType: type })
  return index
}

export function translateChunk(chunk: Record<string, unknown>, state: TranslateState): StreamChunk[] {
  const out: StreamChunk[] = []
  const usageChunk = chunk['usage'] !== undefined
    ? toTokenUsage(chunk['usage'] as Record<string, unknown>)
    : undefined
  let usageEmitted = false
  const choices = Array.isArray(chunk['choices']) ? (chunk['choices'] as Array<Record<string, unknown>>) : []
  for (const choice of choices) {
    const delta = (choice['delta'] ?? {}) as Record<string, unknown>
    if (typeof delta['content'] === 'string' && delta['content'] !== '') {
      const index = beginBlock(state, out, 'text')
      state.openText += delta['content']
      out.push({ type: 'text-delta', index, text: delta['content'] })
    }
    if (typeof delta['reasoning_content'] === 'string' && delta['reasoning_content'] !== '') {
      const index = beginBlock(state, out, 'reasoning')
      state.openReasoning += delta['reasoning_content']
      out.push({ type: 'reasoning-delta', index, text: delta['reasoning_content'] })
    }
    const toolCalls = Array.isArray(delta['tool_calls']) ? (delta['tool_calls'] as Array<Record<string, unknown>>) : []
    for (const tc of toolCalls) {
      const fn = (tc['function'] ?? {}) as Record<string, unknown>
      const index = beginBlock(state, out, 'tool-call')
      if (typeof tc['id'] === 'string' && tc['id'] !== '') state.openToolId = tc['id']
      if (typeof fn['name'] === 'string' && fn['name'] !== '') state.openToolName = fn['name']
      const argsDelta = typeof fn['arguments'] === 'string' ? fn['arguments'] : ''
      if (argsDelta !== '') state.openToolArgs += argsDelta
      out.push({ type: 'tool-call-delta', index, id: state.openToolId, name: state.openToolName, argumentsDelta: argsDelta })
    }
    const finishReason = choice['finish_reason']
    if (typeof finishReason === 'string' && finishReason !== '') {
      closeBlock(state, out)
      // dsh 硬契约:usage 必须先于 finish。
      if (usageChunk !== undefined && !usageEmitted) {
        out.push({ type: 'usage', usage: usageChunk })
        usageEmitted = true
      }
      state.finished = true
      out.push({ type: 'finish', reason: mapFinishReason(finishReason) })
    }
  }
  // usage-only chunk(choices 为空,无 finish):单独发射。
  if (usageChunk !== undefined && !usageEmitted) {
    out.push({ type: 'usage', usage: usageChunk })
  }
  return out
}

function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    default: return { kind: 'error', failure: { message: `provider finish_reason: ${reason}`, code: 'UNKNOWN_FINISH' } }
  }
}

function toTokenUsage(usage: Record<string, unknown>): { inputTokens: number; outputTokens: number; cacheReadTokens?: number } {
  const prompt = typeof usage['prompt_tokens'] === 'number' ? usage['prompt_tokens'] : 0
  const completion = typeof usage['completion_tokens'] === 'number' ? usage['completion_tokens'] : 0
  const details = (usage['prompt_tokens_details'] ?? {}) as Record<string, unknown>
  const cached = typeof details['cached_tokens'] === 'number'
    ? details['cached_tokens'] as number
    : typeof usage['prompt_cache_hit_tokens'] === 'number'
      ? usage['prompt_cache_hit_tokens'] as number
      : 0
  const out: { inputTokens: number; outputTokens: number; cacheReadTokens?: number } = {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: completion,
  }
  if (cached > 0) out['cacheReadTokens'] = cached
  return out
}
