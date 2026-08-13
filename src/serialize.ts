import type { GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'

function textOf(blocks: readonly { type: string; text?: string }[]): string {
  return blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')
}

export function serializeRequest(options: GenerateOptions): Record<string, unknown> {
  const messages = options.messages.map(serializeMessage)
  if (options.system !== undefined) {
    messages.unshift({ role: 'system', content: options.system })
  }
  const body: Record<string, unknown> = {
    model: options.model,
    messages,
    stream: true,
  }
  if (options.tools !== undefined && options.tools.length > 0) {
    body['tools'] = options.tools.map(serializeTool)
  }
  if (options.temperature !== undefined) body['temperature'] = options.temperature
  if (options.maxTokens !== undefined) body['max_tokens'] = options.maxTokens
  if (options.stop !== undefined && options.stop.length > 0) body['stop'] = options.stop
  // "off" → 显式关 thinking,不发射 reasoning_effort。
  if (options.reasoningEffort !== undefined && options.reasoningEffort !== 'off') {
    body['reasoning_effort'] = options.reasoningEffort
  }
  return body
}

function serializeTool(tool: ToolSchema): Record<string, unknown> {
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }
}

function serializeMessage(message: Message): Record<string, unknown> {
  if (message.role === 'assistant') {
    const toolCalls = message.content
      .filter((b) => b.type === 'tool-call')
      .map((b) => {
        const tc = b as { id: string; name: string; arguments: string }
        return { id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } }
      })
    const out: Record<string, unknown> = { role: 'assistant', content: textOf(message.content) }
    if (toolCalls.length > 0) out['tool_calls'] = toolCalls
    return out
  }
  if (message.role === 'user') {
    const toolResults = message.content.filter((b) => b.type === 'tool-result')
    if (toolResults.length > 0) {
      const tr = toolResults[0] as { toolCallId: string; content: readonly { type: string; text?: string }[]; isError?: boolean }
      return { role: 'tool', tool_call_id: tr.toolCallId, content: textOf(tr.content) }
    }
    return { role: 'user', content: textOf(message.content) }
  }
  return { role: 'system', content: textOf(message.content) }
}
