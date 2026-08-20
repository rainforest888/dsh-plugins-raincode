import { createParser } from 'eventsource-parser'
import { LlmError } from '@deepseek-ai/dsh-llm'

/**
 * Parse an SSE response into its `data:` payloads, yielding the `[DONE]`
 * sentinel as the final value. Read/transport failures propagate to the
 * consumer (the adapter maps them to TRANSPORT); the stream ending without
 * `[DONE]` is surfaced by `translate` as STREAM_CLOSED.
 */
export async function* parseSse(resp: Response): AsyncGenerator<string> {
  if (resp.body === null) throw new LlmError('response has no body', 'EMPTY_RESPONSE')
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  const queue: string[] = []
  let done = false
  let failure: unknown = null
  let notify: (() => void) | null = null

  const pump = async (): Promise<void> => {
    try {
      // eventsource-parser v3:createParser 收 config 对象(v2 才是裸回调)。
      const parser = createParser({
        onEvent(event) {
          queue.push(event.data)
          if (notify) { notify(); notify = null }
        },
      })
      for (;;) {
        const { value, done: d } = await reader.read()
        if (d) break
        parser.feed(decoder.decode(value, { stream: true }))
      }
    } catch (error) {
      failure = error
    } finally {
      done = true
      if (notify) { notify(); notify = null }
    }
  }
  void pump()

  try {
    for (;;) {
      if (queue.length > 0) {
        yield queue.shift() as string
        continue
      }
      // done 置位后仍要先清空 queue,否则末尾的事件会被丢弃
      // (pump 可能一次性解析出全部事件,读端却在 done 置位后才醒来)。
      if (done) {
        if (failure !== null) throw failure
        return
      }
      await new Promise<void>((r) => {
        notify = r
        if (queue.length > 0 || done) r()
      })
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}
