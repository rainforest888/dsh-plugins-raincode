import { createParser } from 'eventsource-parser'

/**
 * 把 fetch Response 的 SSE 流解析为逐条 `data:` 内容(跳过 `[DONE]`)。
 * 事件回调在 parser 内部同步执行,故 queue+notify 模式安全。
 */
export async function* readSseData(resp: Response): AsyncGenerator<string> {
  if (resp.body === null) throw new Error('response has no body')
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  const queue: string[] = []
  let done = false
  let notify: (() => void) | null = null

  const pump = async (): Promise<void> => {
    // eventsource-parser v3:createParser 收 config 对象(v2 才是裸回调)。
    const parser = createParser({
      onEvent(event) {
        if (event.data !== '[DONE]') queue.push(event.data)
        if (notify) { notify(); notify = null }
      },
    })
    for (;;) {
      const { value, done: d } = await reader.read()
      if (d) break
      parser.feed(decoder.decode(value, { stream: true }))
    }
  }

  void pump().then(
    () => { done = true; if (notify) { notify(); notify = null } },
    () => { done = true; if (notify) { notify(); notify = null } },
  )

  try {
    for (;;) {
      if (queue.length > 0) {
        yield queue.shift() as string
        continue
      }
      // done 置位后仍要先清空 queue,否则末尾的事件会被丢弃
      // (pump 可能一次性解析出全部事件,读端却在 done 置位后才醒来)。
      if (done) return
      await new Promise<void>((r) => {
        notify = r
        if (queue.length > 0 || done) r()
      })
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}
