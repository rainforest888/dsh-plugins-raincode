# dsh-plugins-raincode-routing

**模型自动路由**——在 DeepSeek Harness(dsh) 内,`raincode_route` 通过 dsh 原生
subagent seam 启动一个强主控模型,把大任务拆解后按方向派发给更便宜的子代理。
插件是"嘴",与 raincode 网关对话;网关(Rust)持有模型池选择、能力档案与路由。

这是 raincode 从 monorepo 拆出的两个插件之一;另一个 `dsh-plugins-raincode-skill`
负责 skill 自进化网络。

## 能力

| 工具 | 何时用 |
|---|---|
| `raincode_route` | 用户明确要求,或任务明显很大(多模块/多方向/长耗时)—聊天先征询。小任务勿用 |
| `raincode_agent_tree` | 用户问"哪个子代理派了哪些孙代理"(渲染 dsh 委派树) |
| `raincode_refresh_model` | 用户说"查一下某模型的能力" |
| `raincode_status` | 用户问 raincode 状态 / 子代理状况 / token 用量(路由与模型池侧) |

`raincode_route` 流程:chat 模型调用工具 → 插件通过 dsh `subagents.start` 用 raincode
主控模型(`mainModel`)启动一个 one-shot 子代理 → 该主控再通过 dsh 原生 subagent 工具派发
子/孙代理。派发深度受 `maxDepth` 限制。

插件还注册一个 `raincode` provider,可接管 dsh 当前的 chat 模型,映射到匹配的 raincode
模型池 profile。

## 前置条件

1. 一个实现 `/v1/models`、`PUT /profiles`、`/capabilities/refresh` 的 **raincode 网关**。
2. 想自动拉起网关(`spawnGateway: true`)则 `raincode` 需在 `PATH` 或设 `RAINCODE_BIN`。
3. dsh profile/preset 必须启用 `subagent` 工具(provider `spawn`)与
   `subagent-spawn-in-process` provider,否则 `raincode_route` 无法启动代理。

## dsh 安装

```bash
dsh plugin --profile web add dsh-plugins-raincode-routing
```

在 patch 层加一行并把 `baseURL` 指向 raincode 网关,重启 `dsh web` 生效。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseURL` | `http://127.0.0.1:8787` | raincode 网关地址 |
| `profiles` | `[]` | 模型池;每个 profile 可设 `role: main/subagent/any` |
| `mainModel` | 空 | `raincode_route` 用的主控模型;自动选 `role=main` profile,否则用 dsh 当前模型 |
| `subagentProvider` | `spawn` | dsh subagent provider 名 |
| `maxDepth` | `3` | `raincode_route` 最大派发深度 |
| `spawnGateway` | `true` | 插件加载时自动启动 `raincode proxy` |
| `gatewayBin` | `RAINCODE_BIN` / `raincode` | 拉起网关用的可执行文件 |
| `streamIdleTimeoutMs` | `300000` | 流式空闲超时 |
| `retryPolicy` | dsh 默认 | 模型调用重试策略 |

## License

MIT