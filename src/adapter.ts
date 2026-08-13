import { attributionHeaders, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { serializeRequest } from './serialize.js'
import { readSseData } from './sse.js'
import { createTranslateState, translateChunk } from './translate.js'

export interface RaincodeModel {
  id: string
  name?: string
  description?: string
}

export interface RaincodeConnectionOptions {
  baseURL: string
  models: RaincodeModel[]
  streamIdleTimeoutMs: number
}

export interface RaincodeAdapterOptions {
  options: () => RaincodeConnectionOptions
  resolveApiKey: () => Promise<string>
}

export class RaincodeAdapter extends LlmAdapter {
  constructor(private readonly opts: RaincodeAdapterOptions) {
    super()
  }

  override async listModels(_provider: string): Promise<LlmModelInfo[]> {
    const models = this.opts.options().models
    if (models.length === 0) return []
    return models.map((m) => ({
      provider: 'raincode',
      id: m.id,
      name: m.name ?? m.id,
      ...(m.description !== undefined ? { description: m.description } : {}),
      inputModalities: ['text'] as const,
    }))
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const found = this.opts.options().models.find((m) => m.id === model)
    return {
      provider,
      id: model,
      name: found?.name ?? model,
      ...(found?.description !== undefined ? { description: found.description } : {}),
    }
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const conn = this.opts.options()
    const apiKey = await this.opts.resolveApiKey()
    const body = serializeRequest(options)
    const url = `${conn.baseURL.replace(/\/+$/, '')}/v1/chat/completions`
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
          ...attributionHeaders(),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        throw mapHttpError(resp.status, text)
      }
      const state = createTranslateState()
      for await (const data of readSseData(resp)) {
        let chunk: Record<string, unknown>
        try {
          chunk = JSON.parse(data) as Record<string, unknown>
        } catch {
          continue
        }
        for (const sc of translateChunk(chunk, state)) yield sc
        if (state.finished) return
      }
      if (!state.finished) {
        throw new LlmError('raincode gateway stream ended without a finish chunk', 'STREAM_CLOSED')
      }
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
    }
  }
}

function mapHttpError(status: number, body: string): LlmError {
  const message = `raincode gateway ${status}: ${body.slice(0, 300)}`
  switch (status) {
    case 401:
    case 403:
      return new LlmError(message, 'AUTH')
    case 429:
      return new LlmError(message, 'RATE_LIMIT')
    case 400:
      return /context/i.test(body)
        ? new LlmError(message, 'CONTEXT_WINDOW_EXCEEDED')
        : new LlmError(message, 'INVALID_REQUEST')
    default:
      return new LlmError(message, status >= 500 ? 'SERVER' : `HTTP_${status}`)
  }
}
