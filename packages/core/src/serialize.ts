import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, RequestMessage, ToolSchema } from '@deepseek-ai/dsh-llm'

function flattenText(blocks: readonly { type: string; text?: string }[]): string {
  return blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')
}

/** 文本-only wire:核心 image 块显式拒绝,而不是被 flatten 静默抹掉。 */
function assertTextOnly(blocks: readonly ContentBlock[]): void {
  if (contentHasImage(blocks)) {
    throw new LlmError('The raincode chat-completions adapter does not support image content.', 'UNSUPPORTED_CONTENT')
  }
}

/** 序列化 assistant 消息:文本 + reasoning 回放(仅 tool-call 轮)+ tool_calls。 */
function serializeAssistant(message: { content: readonly ContentBlock[] }): Record<string, unknown> {
  const text = flattenText(message.content)
  const reasoning = message.content
    .filter((b) => b.type === 'reasoning')
    .map((b) => (b as { text: string }).text)
    .join('')
  const toolCalls = message.content
    .filter((b) => b.type === 'tool-call')
    .map((b) => {
      const tc = b as { id: string; name: string; arguments: string }
      return { id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } }
    })
  const out: Record<string, unknown> = { role: 'assistant', content: text }
  // thinking-mode passback:DeepSeek 系上游在 tool-call 轮要求回放 reasoning。
  if (toolCalls.length > 0 && reasoning.length > 0) out['reasoning_content'] = reasoning
  if (toolCalls.length > 0) out['tool_calls'] = toolCalls
  return out
}

/**
 * 序列化对话。DSH 0.2.x 的消息模型与旧版不同:
 * - 工具结果不再是 user 消息里的 `tool-result` 块,而是独立的 `role:'tool'` 消息
 *   (带 `toolCallId`),因此每个 tool 消息直接铺平成一条 OpenAI `role:'tool'`。
 * - 工具增删以 `role:'developer'` 消息表达。OpenAI 兼容 wire 没有对应槽位,且本次
 *   请求的 `options.tools` 已经是当前工具声明的完整快照,所以这里显式丢弃这些
 *   元事件(与 dsh 对"不支持动态工具的 route"的投影结果一致)。
 * - system/user/assistant 保持原语义;空的 user 文本块序列会被丢弃,避免上游以
 *   空 content 拒绝请求。
 */
function serializeMessages(messages: readonly RequestMessage[]): Record<string, unknown>[] {
  const wire: Record<string, unknown>[] = []
  for (const message of messages) {
    assertTextOnly(message.content)
    switch (message.role) {
      case 'system':
        wire.push({ role: 'system', content: flattenText(message.content) })
        break
      case 'developer':
        break
      case 'assistant':
        wire.push(serializeAssistant(message))
        break
      case 'tool':
        wire.push({
          role: 'tool',
          tool_call_id: message.toolCallId,
          content: flattenText(message.content) || '(no output)',
        })
        break
      default: {
        const text = flattenText(message.content)
        if (text.length > 0) wire.push({ role: 'user', content: text })
        break
      }
    }
  }
  return wire
}

function serializeTool(tool: ToolSchema): Record<string, unknown> {
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }
}

export function serializeRequest(options: GenerateOptions): Record<string, unknown> {
  const messages: Record<string, unknown>[] = []
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system })
  }
  messages.push(...serializeMessages(options.messages))
  const body: Record<string, unknown> = {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  }
  const tools = options.tools?.map(serializeTool)
  if (tools !== undefined && tools.length > 0) body['tools'] = tools
  if (options.temperature !== undefined) body['temperature'] = options.temperature
  if (options.maxTokens !== undefined) body['max_tokens'] = options.maxTokens
  if (options.stop !== undefined) body['stop'] = options.stop
  // "off" → 不发射 reasoning_effort(gateway/rc-pro 的既有语义)。
  if (options.reasoningEffort !== undefined && options.reasoningEffort !== 'off') {
    body['reasoning_effort'] = options.reasoningEffort
  }
  // gateway 把 session_id 收进 extra → rc-pro prompt_cache_key(StablePrefix 缓存)。
  if (options.sessionId !== undefined) body['session_id'] = options.sessionId
  return body
}
