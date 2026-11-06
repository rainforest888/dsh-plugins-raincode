/**
 * DSH 0.1.7+ 的 live-config 兼容层。
 *
 * 从 0.1.7 起，插件 `apply(ctx, config)` 里的 config 是"活引用"：被标记为
 * volatile 的字段由 loader 以 cosmokit `Volatile { get() }` 包装传入，读取时
 * 必须调用 `.get()` 才能拿到当前值。settings 服务（0.2.x 的 `SettingsForms`）
 * 只把 schema 上带 volatile 标记的字段投影成可热更新的设置表单，因此每个
 * 想在 GUI 里直接修改、且不重载插件即可生效的字段都要：
 *
 *   1. 有 `.default(...)`（投影会丢弃 undefined 字段）；
 *   2. 用 {@link volatileField} 标记 volatile。
 *
 * 旧版本 SDK 没有 `settingsNamespace()` / `installSettingsSection()` 之后，插件
 * 不再需要把配置注册到 settings 服务：直接读 live config 即可。
 */
import type { Context } from '@deepseek-ai/cordis'

interface SchemaLike {
  volatile?: () => unknown
  extra?: (key: string, value: unknown) => unknown
}

/**
 * 把 schemastery 字段标记为 live（volatile）。
 *
 * schemastery 3.18.4+ 有 `.volatile()` 语法糖；更早的版本用
 * `.extra('volatile', true)` 表达同一含义（dsh-subagent-default-model 的兼容写法）。
 */
export function volatileField<T>(schema: T): T {
  const candidate = schema as unknown as SchemaLike
  const live = typeof candidate.volatile === 'function' ? candidate.volatile() : undefined
  if (live !== undefined) return live as T
  if (typeof candidate.extra === 'function') return candidate.extra('volatile', true) as T
  return schema
}

interface LiveRef<T> {
  get(): T
}

function isLiveRef(value: unknown): value is LiveRef<unknown> {
  if (typeof value !== 'object' || value === null) return false
  const get = (value as { get?: unknown }).get
  // Volatile 实例只有一个 get 方法（可能附一个 symbol）；普通对象不会命中。
  return typeof get === 'function' && Object.keys(value).length <= 2
}

/** 解包单个 live 字段；普通值原样返回。 */
export function liveValue<T>(value: unknown): T | undefined {
  let current: unknown = value
  const seen = new Set<unknown>()
  while (isLiveRef(current) && !seen.has(current)) {
    seen.add(current)
    const next = current.get()
    if (next === current) break
    current = next
  }
  return current as T | undefined
}

/** 递归去掉活引用/普通容器里的包装，得到可安全序列化和读取的纯配置。 */
function plainValue(value: unknown): unknown {
  const unwrapped = liveValue(value)
  if (Array.isArray(unwrapped)) return unwrapped.map((item) => plainValue(item))
  if (typeof unwrapped === 'object' && unwrapped !== null) {
    const proto = Object.getPrototypeOf(unwrapped) as object | null
    if (proto !== Object.prototype && proto !== null) return unwrapped
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(unwrapped as Record<string, unknown>)) {
      out[key] = plainValue(item)
    }
    return out
  }
  return unwrapped
}

/**
 * 把 `apply()` 收到的活配置读成纯对象。每次调用都重新解包，因此 settings
 * 写入后无需重挂载插件，下一次读取自然拿到新值。
 */
export function readLiveConfig<T extends object>(raw: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    out[key] = plainValue(value)
  }
  return out as T
}

interface LoaderEntryLike {
  options?: { id?: unknown; name?: unknown }
}

/**
 * 解析插件在当前 profile 里的 settings namespace。
 *
 * dsh 0.2.x 的 settings 表单以 **loader 条目 id** 为 namespace（而不是包名），
 * 同一个包可能以 `raincode-routing`、`include:raincode-routing` 等不同 id 挂载，
 * 因此这里从 loader 条目反查；找不到时回退包名（大多数安装方式二者相同）。
 */
export function resolveSettingsNamespace(ctx: Context, packageName: string): string {
  try {
    const loader = (ctx as unknown as { get(name: string): unknown }).get('loader') as
      | { entries?: () => Iterable<LoaderEntryLike> }
      | undefined
    if (typeof loader?.entries !== 'function') return packageName
    const entries = [...loader.entries()].flatMap((entry) => {
      const id = entry.options?.id
      const name = entry.options?.name
      return typeof id === 'string' ? [{ id, name: typeof name === 'string' ? name : '' }] : []
    })
    const exact = entries.find((entry) => entry.name === packageName || entry.id === packageName)
    if (exact !== undefined) return exact.id
    const loose = entries.find((entry) => entry.id.includes(packageName) || entry.name.includes(packageName))
    if (loose !== undefined) return loose.id
  } catch {
    // loader 服务不可用（旧版本/测试环境）时退回包名。
  }
  return packageName
}
