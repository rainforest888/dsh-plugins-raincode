import { describe, it, expect } from 'vitest'
import { serializeRequest } from './serialize.js'
import type { GenerateOptions, Message, ContentBlock } from '@deepseek-ai/dsh-llm'

function msg(role: 'user' | 'assistant', blocks: ContentBlock[]): Message {
  return {
    id: `m-${Math.random()}`,
    role,
    content: blocks,
    source: role === 'assistant' ? { kind: 'model', provider: 'raincode', model: 'm' } : { kind: 'user' },
  }
}

describe('serializeRequest', () => {
  const options: GenerateOptions = {
    provider: 'raincode',
    model: 'deepseek-v4-flash',
    system: 'You are a coding agent.',
    messages: [
      msg('user', [{ type: 'text', text: 'hello' }]),
      msg('assistant', [
        { type: 'reasoning', text: 'need to read' },
        { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a.ts"}' },
      ]),
      msg('user', [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'ok' }] }]),
    ],
    tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
    stop: ['END'],
    reasoningEffort: 'high',
    sessionId: 'sess-9',
  }

  it('builds a deepseek-compatible chat body', () => {
    const body = serializeRequest(options)
    expect(body['model']).toBe('deepseek-v4-flash')
    expect(body['stream']).toBe(true)
    expect(body['stream_options']).toEqual({ include_usage: true })
    expect(body['stop']).toEqual(['END'])
    expect(body['reasoning_effort']).toBe('high')
    expect(body['session_id']).toBe('sess-9')
    const messages = body['messages'] as Record<string, unknown>[]
    expect(messages[0]).toEqual({ role: 'system', content: 'You are a coding agent.' })
    expect(messages[1]).toEqual({ role: 'user', content: 'hello' })
    // thinking passback:reasoning 只在 tool-call 轮回放。
    expect(messages[2]).toMatchObject({ role: 'assistant', reasoning_content: 'need to read', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a.ts"}' } }] })
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'ok' })
    const tools = body['tools'] as Record<string, unknown>[]
    expect(tools[0]).toMatchObject({ type: 'function', function: { name: 'read' } })
  })

  it('omits reasoning_effort when off', () => {
    const body = serializeRequest({ ...options, reasoningEffort: 'off' })
    expect(body['reasoning_effort']).toBeUndefined()
  })

  it('expands every tool result into its own tool message, user text first', () => {
    const body = serializeRequest({
      ...options,
      system: undefined,
      messages: [
        msg('user', [
          { type: 'text', text: 'results:' },
          { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'a' }] },
          { type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'b' }] },
        ]),
      ],
    })
    const messages = body['messages'] as Record<string, unknown>[]
    expect(messages).toEqual([
      { role: 'user', content: 'results:' },
      { role: 'tool', tool_call_id: 'c1', content: 'a' },
      { role: 'tool', tool_call_id: 'c2', content: 'b' },
    ])
  })

  it('does not replay assistant reasoning on plain text turns', () => {
    const body = serializeRequest({
      ...options,
      system: undefined,
      messages: [msg('assistant', [{ type: 'reasoning', text: 'silent' }, { type: 'text', text: 'hi' }])],
    })
    const messages = body['messages'] as Record<string, unknown>[]
    expect(messages[0]).toEqual({ role: 'assistant', content: 'hi' })
  })

  it('rejects image content instead of silently erasing it', () => {
    const imageBlock = { type: 'image', attachment: 'att_1' } as unknown as ContentBlock
    try {
      serializeRequest({
        ...options,
        system: undefined,
        messages: [msg('user', [imageBlock])],
      })
      expect.unreachable('serializeRequest must reject image content')
    } catch (error) {
      expect(error).toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    }
  })
})
