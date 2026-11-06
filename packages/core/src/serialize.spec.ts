import { describe, it, expect } from 'vitest'
import {
  ReasoningEffortId,
  ToolCallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm'
import { serializeRequest } from './serialize.js'

function user(blocks: ContentBlock[]) {
  return createUserMessage({ content: blocks, source: { kind: 'user' } })
}

function assistant(blocks: ContentBlock[]) {
  return createAssistantMessage({ content: blocks, source: { provider: 'raincode', model: 'deepseek-v4-flash' } })
}

describe('serializeRequest', () => {
  const options: GenerateOptions = {
    provider: 'raincode',
    model: 'deepseek-v4-flash',
    system: 'You are a coding agent.',
    messages: [
      user([{ type: 'text', text: 'hello' }]),
      assistant([
        { type: 'reasoning', text: 'need to read' },
        { type: 'tool-call', id: ToolCallId('call_1'), name: 'read', arguments: '{"path":"a.ts"}' },
      ]),
      createToolResultMessage({
        callId: ToolCallId('call_1'),
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      }),
    ],
    tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
    stop: ['END'],
    reasoningEffort: ReasoningEffortId('high'),
    sessionId: 'sess-9' as unknown as GenerateOptions['sessionId'],
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
    const body = serializeRequest({ ...options, reasoningEffort: ReasoningEffortId('off') })
    expect(body['reasoning_effort']).toBeUndefined()
  })

  it('serializes each tool-role message as its own tool message', () => {
    const body = serializeRequest({
      ...options,
      system: undefined,
      messages: [
        user([{ type: 'text', text: 'results:' }]),
        createToolResultMessage({ callId: ToolCallId('c1'), content: [{ type: 'text', text: 'a' }], isError: false }),
        createToolResultMessage({ callId: ToolCallId('c2'), content: [{ type: 'text', text: 'b' }], isError: false }),
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
      messages: [assistant([{ type: 'reasoning', text: 'silent' }, { type: 'text', text: 'hi' }])],
    })
    const messages = body['messages'] as Record<string, unknown>[]
    expect(messages[0]).toEqual({ role: 'assistant', content: 'hi' })
  })

  it('drops developer tool-update messages the wire cannot carry', () => {
    const body = serializeRequest({
      ...options,
      system: undefined,
      messages: [
        user([{ type: 'text', text: 'hi' }]),
        {
          id: 'dev-1' as never,
          role: 'developer',
          content: [{ type: 'tool-removal', toolName: 'read' }],
          source: { kind: 'user' },
        },
      ],
    })
    const messages = body['messages'] as Record<string, unknown>[]
    expect(messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('rejects image content instead of silently erasing it', () => {
    const imageBlock = { type: 'image', attachment: 'att_1' } as unknown as ContentBlock
    try {
      serializeRequest({
        ...options,
        system: undefined,
        messages: [user([imageBlock])],
      })
      expect.unreachable('serializeRequest must reject image content')
    } catch (error) {
      expect(error).toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    }
  })
})
