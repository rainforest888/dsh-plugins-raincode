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
        { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a.ts"}' },
      ]),
      msg('user', [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'ok' }] }]),
    ],
    tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
    stop: ['END'],
    reasoningEffort: 'high',
  }

  it('builds a deepseek-compatible chat body', () => {
    const body = serializeRequest(options)
    expect(body['model']).toBe('deepseek-v4-flash')
    expect(body['stream']).toBe(true)
    expect(body['stop']).toEqual(['END'])
    expect(body['reasoning_effort']).toBe('high')
    const messages = body['messages'] as Record<string, unknown>[]
    expect(messages[0]).toEqual({ role: 'system', content: 'You are a coding agent.' })
    expect(messages[1]).toEqual({ role: 'user', content: 'hello' })
    expect(messages[2]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a.ts"}' } }] })
    expect(messages[3]).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: 'ok' })
    const tools = body['tools'] as Record<string, unknown>[]
    expect(tools[0]).toMatchObject({ type: 'function', function: { name: 'read' } })
  })

  it('omits reasoning_effort when off', () => {
    const body = serializeRequest({ ...options, reasoningEffort: 'off' })
    expect(body['reasoning_effort']).toBeUndefined()
  })
})
