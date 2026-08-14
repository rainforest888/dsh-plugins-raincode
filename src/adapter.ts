import {
  attributionHeaders,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmAdapter,
  LlmError,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { serializeRequest } from './serialize.js'
import { parseSse } from './sse.js'
import { translate } from './translate.js'

export interface RaincodeModel {
  id: string
  name?: string
  description?: string
}

export interface RaincodeConnectionOptions {
  baseURL: string
  models: RaincodeModel[]
  streamIdleTimeoutMs: number
  retryPolicy: ResolvedRetryPolicy
}

export interface RaincodeAdapterOptions {
  options: () => RaincodeConnectionOptions
  resolveApiKey: () => Promise<string>
}

const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'
const CATALOG_TTL_MS = 30_000

export class RaincodeAdapter extends LlmAdapter {
  private catalog: { models: RaincodeModel[]; at: number } | undefined

  constructor(private readonly opts: RaincodeAdapterOptions) {
    super()
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'Raincode' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.opts.options().retryPolicy
  }

  /** config.models 优先;为空时从 gateway `/v1/models` 拉取(30s 缓存,失败返回空)。 */
  private async catalogModels(): Promise<RaincodeModel[]> {
    const configured = this.opts.options().models
    if (configured.length > 0) return configured
    if (this.catalog !== undefined && Date.now() - this.catalog.at < CATALOG_TTL_MS) {
      return this.catalog.models
    }
    try {
      const resp = await fetch(`${this.opts.options().baseURL.replace(/\/+$/, '')}/v1/models`, {
        headers: { accept: 'application/json', ...attributionHeaders() },
      })
      if (!resp.ok) return []
      const data = (await resp.json()) as { data?: Array<{ id?: string; name?: string }> }
      const models: RaincodeModel[] = (data.data ?? [])
        .filter((m) => typeof m.id === 'string' && m.id.length > 0)
        .map((m) => ({ id: m.id as string, name: m.name }))
      this.catalog = { models, at: Date.now() }
      return models
    } catch {
      return []
    }
  }

  override async listModels(provider: string): Promise<LlmModelInfo[]> {
    return (await this.catalogModels()).map((m) => ({
      provider,
      id: m.id,
      name: m.name ?? m.id,
      ...(m.description !== undefined ? { description: m.description } : {}),
      inputModalities: ['text'] as const,
    }))
  }

  override async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const found = (await this.catalogModels()).find((m) => m.id === model)
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
    const consumer = new AbortController()
    const upstream = options.signal
    const watchdog = idleWatchdog(
      upstream === undefined ? consumer.signal : AbortSignal.any([upstream, consumer.signal]),
      conn.streamIdleTimeoutMs,
      STREAM_IDLE_TIMEOUT_CODE,
    )
    try {
      const iterator = this.request(options, watchdog.signal, conn, apiKey)[Symbol.asyncIterator]()
      let exhausted = false
      try {
        for (;;) {
          const result = await watchdog.next(iterator)
          if (result.done) {
            exhausted = true
            return
          }
          yield result.value
        }
      } catch (error) {
        if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
          throw new LlmError(`raincode stream idle timeout after ${conn.streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error })
        }
        if (upstream?.aborted === true) {
          throw new LlmError('raincode request aborted by caller', 'ABORTED', { cause: error })
        }
        if (error instanceof LlmError) throw error
        throw new LlmError(`raincode gateway stream from ${conn.baseURL} failed`, 'TRANSPORT', { cause: error })
      } finally {
        consumer.abort('raincode stream consumer stopped')
        if (!exhausted && iterator.return !== undefined) {
          try {
            await iterator.return(undefined)
          } catch {
            // 传输层 teardown 失败不掩盖主错误。
          }
        }
      }
    } finally {
      watchdog[Symbol.dispose]()
    }
  }

  private async * request(
    options: GenerateOptions,
    signal: AbortSignal,
    conn: RaincodeConnectionOptions,
    apiKey: string,
  ): AsyncGenerator<StreamChunk> {
    const body = serializeRequest(options)
    const url = `${conn.baseURL.replace(/\/+$/, '')}/v1/chat/completions`
    let resp: Response
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...attributionHeaders(),
        },
        body: JSON.stringify(body),
        signal,
      })
    } catch (error) {
      if (signal.aborted) throw error
      throw new LlmError(`raincode gateway request to ${conn.baseURL} failed`, 'TRANSPORT', { cause: error })
    }
    if (!resp.ok) {
      let message = `raincode gateway error (HTTP ${resp.status})`
      let detail = ''
      try {
        const payload = (await resp.json()) as { error?: { message?: string; code?: string; type?: string } }
        if (payload.error?.message !== undefined) message = payload.error.message
        detail = [payload.error?.code, payload.error?.type, payload.error?.message].filter(Boolean).join(' ')
      } catch {
        // 非 JSON 错误体;message 保持 HTTP 概览。
      }
      throw new LlmError(message, httpErrorCode(resp.status, detail), { status: resp.status })
    }
    if (resp.body === null) {
      throw new LlmError('raincode gateway returned no response body', 'EMPTY_RESPONSE')
    }
    yield * translate(parseSse(resp))
  }
}

function httpErrorCode(status: number, detail: string): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (isQuotaExceededError(detail)) return 'QUOTA'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    return isContextWindowExceededError(detail) ? 'CONTEXT_WINDOW_EXCEEDED' : 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}
