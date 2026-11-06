# dsh 插件 —— raincode 作为 DeepSeek Harness 的模型层

日期：2026-08-13
状态：已批准（用户确认方案 1「升级 gateway + 薄 TS 适配器」，交付形态：GitHub `dsh-plugins-raincode` + npm 发布；范围增补：在 dsh 内**选择模型 + 查看 skill**）

## 1. 目的

DeepSeek Harness（`dsh`，DeepSeek 官方 2026-08-13 发布，Node/TS、Cordis、一切皆插件）是 agent harness；raincode 是模型层 harness 优化器（Rust）。本设计做一个**真正的 dsh 插件**，让 dsh 的模型层 = raincode：低价模型池 + StablePrefix 缓存 + 重试/故障转移。dsh 保持自身 agent 循环，raincode 管模型层。

**用户可感知的两个能力**（在 dsh 内）：
1. **选择模型**：dsh 模型选择器里能看到 raincode 模型池，选中哪个模型，gateway 就用哪个 profile（精确映射）。
2. **查看 skill**：dsh 里跑 `/skills` 命令，浏览 raincode 的 skill 库（列表 + 查看正文）。

**形态**：gateway 是「脑」（Rust，raincode 仓库），插件是「嘴」（TypeScript，`dsh-plugin` 生态）。插件把 dsh 的 `GenerateOptions` 翻译成 OpenAI wire 发给 raincode gateway，再把 gateway 的 OpenAI chunk 翻译回 dsh `StreamChunk`。插件不持有模型逻辑。

## 2. 架构

```
┌──────────── GitHub: dsh-plugins-raincode (TypeScript/Cordis 插件) ────────────┐
│  LlmAdapter（provider 路由 "raincode"）                                       │
│   stream()      → POST http://127.0.0.1:8787/v1/chat/completions (SSE)      │
│   translate     → OpenAI chunk → dsh StreamChunk                             │
│   resolveModel()→ 从 gateway /v1/models 暴露模型池                            │
└──────────────────────────────────────┬───────────────────────────────────────┘
                                       │ HTTP（OpenAI-compat）
┌──────────────────────────────────────▼───────────────────────────────────────┐
│  raincode 仓库 · crates/rc-gateway（Rust，已存在，本迭代补齐 wire）            │
│   /v1/chat/completions：按 model 选 profile → rc-pro provider → 流式          │
│   /v1/models：从 registry 列出模型池                                          │
└──────────────────────────────────────────────────────────────────────────────┘
```

## 3. 组件

### 3.1 Rust 侧：`crates/rc-gateway` 补齐（6 项）

1. **按 model 选 profile**：`chat_completions` 的 `model` 字段先精确匹配 `profile.model` 或 `profile.id`，未命中回退 active。dsh 选 qwen3.8-max → gateway 用 qwen3.8-max 的 profile。
2. **流式 wire 补齐**：Finish 时**先**发 usage chunk（`prompt_tokens` / `completion_tokens` / `prompt_cache_hit_tokens`），再发 finish chunk（带 `finish_reason`），最后 `data: [DONE]`。
3. **请求侧解析**：`stop`、`reasoning_effort` / `thinking`（尽量透传；`off` → 不传 reasoning）。透传实现待 rc-pro 核实：`CanonicalRequest.extra` 是否被各 provider 转发到上游，若不透传则映射到已支持的请求字段或显式忽略并在文档说明。
4. **工具调用 index 递增**：按 call id 递增（当前恒 0，多工具调用会撞 index）。
5. **新增 `/v1/models`**：列出 registry 池（id / name / context），供插件发现模型。
6. **新增 `/skills`**：用 `SkillStore::discover`（`~/.raincode/skills/`）返回 skill 列表（name / category / description / tags / body），供插件 `/skills` 命令浏览。

### 3.2 TS 侧：`dsh-plugins-raincode` 插件（新 GitHub repo）

镜像 llm-deepseek 布局（wire 序列化 / SSE / chunk 翻译 / 适配器 / 插件入口分离）：

| 文件 | 职责 |
|---|---|
| `serialize.ts` | dsh `Message[]` / `system` / `tools` / `GenerateOptions` → OpenAI 请求体 |
| `sse.ts` | SSE 解析 + `[DONE]` 兜底 |
| `translate.ts` | OpenAI chunk → `StreamChunk` |
| `adapter.ts` | `RaincodeAdapter extends LlmAdapter` |
| `commands.ts` | 注册 `/skills` 命令（列表 / 查看正文），调 gateway `/skills` |
| `index.ts` | 插件 `apply` / `registerAdapter` / 注册命令 / Config schema |

**两个入口**：`inject: ['llm']` 注册模型 provider（provider 路由 `raincode`）；`inject: ['commands']` 注册 `/skills` 命令（无参数=列 skill 清单，`/skills <name>`=看正文）。

**Config 字段**：

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseURL` | `http://127.0.0.1:8787` | raincode gateway 地址 |
| `apiKeyEnv` | `RAINCODE_API_KEY` | 仅满足 dsh 凭据接缝；gateway 本地不校验 |
| `spawnGateway` | `false` | gateway 未起时自动 `raincode proxy` |
| `models` | 无 | 可覆盖；默认从 `/v1/models` 拉 |
| `streamIdleTimeoutMs` | 300000 | 复用 dsh 的 helper |
| `retryPolicy` | dsh 默认 | 复用 dsh 的 helper |

**依赖**（npm 均已发布，已核实）：`@deepseek-ai/dsh-llm`（0.0.1-rc.1，含 `LlmAdapter`/`LlmError`）、`@deepseek-ai/cordis`（4.0.1）、`@deepseek-ai/schemastery`（3.18.1）、`@deepseek-ai/dsh-settings`、`@deepseek-ai/dsh-credentials`、`@deepseek-ai/dsh-launch-environment`、`@deepseek-ai/dsh-anonymous-user-id`、`@deepseek-ai/dsh-timeout`、`eventsource-parser`。

## 4. 数据流与 wire 契约

```
GenerateOptions{provider:'raincode', model:'deepseek-v4-flash', messages, tools, reasoningEffort, stop}
  → serialize → POST /v1/chat/completions {model, messages, tools, stream:true, reasoning_effort, stop}
  → gateway 选 profile → rc-pro → 上游 opencode.ai → SSE
  → 上游事件转 OpenAI chunk：
      content             → delta.content             → 插件 → text-delta
      thinking            → delta.reasoning_content   → 插件 → reasoning-delta
      tool call           → delta.tool_calls[index]   → 插件 → tool-call-delta
      finish              → usage chunk + finish + [DONE] → 插件 → usage → finish
```

**翻译硬性约束**（dsh `StreamChunk` 契约）：usage **必须**先于 finish，finish 之后不再有输出；`tool-call` 的 `arguments` 始终是原始 JSON 串；缺 `[DONE]` 报 `STREAM_CLOSED`。

**模型选择语义**：dsh 模型选择器显示 raincode 池各 profile；选中的 `model` 决定 gateway 用哪个 profile。v1 是**精确映射**（所见即所得），不做自动能力路由。

**skills 命令流**：

```
用户 /skills              → 命令 handler → GET gateway /skills → 渲染 name+category+description 清单
用户 /skills <name>       → 命令 handler → 匹配清单 → 渲染正文（SKILL.md body）
```

## 5. 错误处理

| 情况 | 映射 |
|---|---|
| gateway 非 2xx（`{"error":{message}}` JSON） | `LlmError`：401/403→AUTH、429→RATE_LIMIT、5xx→SERVER、400 上下文→CONTEXT_WINDOW_EXCEEDED |
| 连接失败 / gateway 未启动 | TRANSPORT；`spawnGateway` 尝试拉起 |
| 流无 `[DONE]` | STREAM_CLOSED |
| 上游 thinking → `reasoning_content` | reasoning-delta（输出侧通） |

## 6. 测试

- **Rust**：gateway 流式 wire 单测 —— usage 先于 finish、`[DONE]` 结尾、工具 index 递增、按 model 选 profile；`/skills` 返回已发现 skill 清单。
- **TS**：serialize / translate 单测 + 集成测试（真 gateway + 模拟上游，断言完整 `StreamChunk` 序列）；`/skills` 命令 handler 单测（mock gateway 返回，断言渲染文本）。
- **dsh 端到端**：可选（需本地装 `npx @deepseek-ai/dsh web`），真跑一轮对话 + 工具调用 + `/skills` 浏览。先做 wire 级验证。

## 7. 交付

- **GitHub repo**：`rainforest888/dsh-plugins-raincode`（`gh` 已登录 rainforest888；`dsh-plugins` 组织不存在且无 admin:org 权限，故用账户下仓库）
- **GitHub repo**：`rainforest888/dsh-plugins-raincode`（`gh` 已登录 rainforest888；`dsh-plugins` 组织不存在且无 admin:org 权限，故用账户下仓库）
- **GitHub topics**（建仓时一次性写入，上限 20）：
  `dsh-plugin`、`raincode`、`deepseek-harness`、`deepseek`、`llm`、`llm-gateway`、`openai-compatible`、`agent-harness`、`ai-agent`、`coding-agent`、`model-routing`、`model-pool`、`prompt-caching`、`cost-optimization`、`multi-model`、`typescript`、`rust`、`plugin`（18 个）
- **npm 包**：`dsh-plugins-raincode`（名称已核实可用）
- **README**：说明插件作用（dsh 模型层 = raincode）、安装/配置（cordis.yml `baseURL` 示例）、模型池、FAQ
- **发布前置**：用户需先 `npm login`（当前 npm 未登录；到时请用户跑 `! npm login`）

## 8. 范围外

- raincode `route` 能力路由接入（自动拆解 / 跨 profile 故障转移）—— 后续迭代
- raincode skill 的**导航/自动注入**（把 SkillNavigator 接进 dsh agent 循环，而非仅 `/skills` 浏览）—— 后续迭代
- `/v1/messages`（Anthropic 端）改动
- gateway 鉴权 / TLS
