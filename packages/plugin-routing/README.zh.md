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

`raincode_route` 流程:chat 模型调用工具 → 插件通过 dsh `subagents.startActivation` 用 raincode
主控模型(`mainModel`)启动一个 one-shot 子代理 → 该主控再通过 dsh 原生 subagent 工具派发
子/孙代理。派发深度受 `maxDepth` 限制。

`raincode` provider 与适配器由本插件注册(skill 插件不再注册,两个插件同装不会重复声明),
并可接管 dsh 中模型属于模型池的 chat 请求。

## 前置条件

1. 一个实现 `/v1/models`、`PUT /profiles`、`/capabilities/refresh` 的 **raincode 网关**。
2. dsh `>= 0.2.2-rc.1`。
3. 想自动拉起网关(`spawnGateway: true`)时,`raincode` 二进制需能被找到:`gatewayBin` 设置、
   `RAINCODE_BIN`、仓库 `target/release/`、`~/.raincode/bin` 或 `PATH`。
3. dsh profile/preset 必须启用 `subagent` 工具(provider `spawn`)与
   `subagent-spawn-in-process` provider,否则 `raincode_route` 无法启动代理。

## dsh 安装

需要 dsh `>= 0.2.2-rc.1`。在仓库中:

```bash
dsh plugin --profile my-profile add "link:$PWD"
```

包自带 `cordis.patch.yml`(通过 `dsh.bundle.patch` 声明),loader 行会自动插入;
可用 `dsh --profile my-profile --dump-config` 校验。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseURL` | `http://127.0.0.1:8787` | raincode 网关地址 |
| `profiles` | `[]` | 模型池;每个 profile 可设 `role: main/subagent/any` |
| `mainModel` | 空 | `raincode_route` 用的主控模型;自动选 `role=main` profile,否则用 dsh 当前模型 |
| `subagentProvider` | `spawn` | dsh subagent provider 名 |
| `maxDepth` | `3` | `raincode_route` 最大派发深度 |
| `spawnGateway` | `true` | 插件加载时自动启动 `raincode proxy` |
| `gatewayBin` | 自动探测 | 网关可执行文件;留空时按 `RAINCODE_BIN` / 仓库构建 / `~/.raincode/bin` / `PATH` 查找 |
| `streamIdleTimeoutMs` | `300000` | 流式空闲超时 |
| `retryPolicy` | dsh 默认 | 模型调用重试策略 |

## License

MIT