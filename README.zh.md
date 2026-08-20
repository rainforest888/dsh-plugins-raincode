# dsh-plugins-raincode

让 **raincode** 成为 **DeepSeek Harness(dsh)** 的模型层:低价模型池 + StablePrefix
提示缓存 + 重试/故障转移,由本地 OpenAI 兼容 gateway 驱动。在 dsh 里你可以从
raincode 模型池里任意选模型,并用 `/skills` 浏览 raincode 的 skill 库。

插件是「嘴」——把 dsh 的 `GenerateOptions` 翻译成 OpenAI wire 发给 raincode
gateway,再把 OpenAI chunk 翻译回 dsh `StreamChunk`;raincode gateway(Rust)是
「脑」,持有 profile 选择、缓存与重试。插件不持有任何模型逻辑。

## 前置条件

1. **安装 raincode**(≥ 0.1.0,含 gateway 的 `/v1/models` 与 `/skills`):

   ```bash
   cd raincode
   cargo install --path crates/rc-cli
   # 或用 ./install.sh
   ```

2. **配置 profile(模型池)**:

   ```bash
   raincode setup
   # 写入 ~/.raincode/profiles.toml
   ```

3. **启动 gateway**(保持运行):

   ```bash
   raincode proxy --port 8787
   ```

   验证:`curl http://127.0.0.1:8787/health` → `{"ok":true,"service":"raincode-gateway"}`。

## 必需的 dsh 子代理插件

`raincode_route` 依赖 dsh 的 **subagent seam**。你的 dsh profile/preset 必须已启用:

- `subagent` 模型工具(来自 `@deepseek-ai/dsh-tool-subagent`,provider 名 `spawn`);
- 对应 provider(`@deepseek-ai/dsh-subagent-spawn-in-process`,注册名 `spawn`)。

DeepSeek Harness 的 Standard preset 自带这些行;自定义 preset 至少需要:
- `tool-subagent`(provider: spawn)
- `subagent-spawn-in-process`

没有这些插件时,raincode 插件无法加载(它显式 `inject: ['subagents', ...]`)。

## 在 dsh 中安装

```bash
dsh plugin --profile web add dsh-plugins-raincode
```

然后编辑该 profile 的补丁层(`~/.dsh/profiles/web/cordis.patch.yml`,所有 profile
通用则写 `~/.dsh/cordis.patch.yml`),插入插件行:

```yaml
- insert:
    - id: raincode
      name: dsh-plugins-raincode
      config:
        baseURL: http://127.0.0.1:8787
        apiKeyEnv: RAINCODE_API_KEY
```

`dsh --profile web --dump-config` 应能看到 raincode 行。重启 `dsh web` 生效。

## 工具

| 工具 | 触发方式 |
|---|---|
| `raincode_route` | 用户明确要求,或任务明显很大(多模块/多方向/长时执行)时,chat 模型先询问用户再调用。小任务不要调用 |
| `raincode_agent_tree` | 用户问“哪个子代理派了哪些孙代理”时,输出父子关系树 |
| `raincode_refresh_model` | 用户说“帮我查看 xxx 模型的能力” |
| `raincode_learn` | 用户说“学习一下这次任务 / 把经验沉淀成 skill” |
| `raincode_status` | 用户问 raincode 状态 / 子代理工作状况 / token 用量 |
| `raincode_skill_search` / `raincode_skill_load` | 使用 raincode skill 网络 |

`raincode_route` 的工作方式:chat 模型调用该工具 → 插件用 dsh `subagents.start` 启动一个 one-shot 子代理,该子代理使用 raincode 主控模型(`mainModel`),并继续用 dsh 原生 subagent 工具派发子代理/孙代理。

孙代理的 UI 沿用 dsh 原版子代理界面:dsh Web UI 的会话头部 subagent catalog 支持逐层展开(父→子→孙),点击任意深度即可打开对应 child;每个子代理行显示其直接后代数量。raincode 保证所有层级都走 dsh 原生 subagent seam,因此父子关系与展示由 dsh 原生维护。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `baseURL` | `http://127.0.0.1:8787` | raincode gateway 地址 |
| `apiKeyEnv` | `RAINCODE_API_KEY` | 仅满足 dsh 凭据接缝;本地 loopback gateway 不校验 key(缺失也不报错) |
| `models` | `[]` | 可选静态目录覆盖;缺省自动从 gateway `/v1/models` 拉取模型池 |
| `profiles` | `[]` | 模型池;每个 profile 可设 `role: main/subagent/any` 和方向 `tags` |
| `mainModel` | 空 | raincode 主控模型;留空时自动选 `role=main` 的 profile,再回退 dsh 当前模型 |
| `subagentProvider` | `spawn` | dsh subagent provider 名(需要已注册) |
| `maxDepth` | `3` | `raincode_route` 的最大委派深度(子代理→孙代理→曾孙代理) |
| `streamIdleTimeoutMs` | `300000` | 流式空闲超时(复用 dsh-timeout helper) |
| `retryPolicy` | dsh 默认 | 重试策略(复用 `RetryPolicySchema`/`resolveRetryPolicy`) |

## 你能得到什么

- **选模型** —— dsh 模型选择器显示 raincode 模型池(来自 `/v1/models`);选中的
  model 精确映射到 gateway 的 profile。
- **`/skills` 浏览** —— `/skills` 列出 raincode skill 库,`/skills <name>` 看正文。
  数据来自 gateway 的 `/skills` 端点(`~/.raincode/skills/`)。
- **缓存与重试** —— 提示缓存(`sessionId → prompt_cache_key`)与重试/故障转移由
  gateway 按 profile 兜底,dsh 侧无需配置。

## FAQ

- **raincode_route 不可用?** 检查 profile/preset 是否启用了 `subagent` 工具和 `spawn` provider(见“必需的 dsh 子代理插件”)。

- **gateway 没启动?** 模型调用会报 TRANSPORT 类错误。先 `raincode proxy --port 8787`。
- **为什么 API key 是摆设?** 本地 loopback gateway 信任本机,真实上游 key 从
  `~/.raincode/profiles.toml` 解析(支持 api_key / api_key_file / api_key_env)。
  指向本机 gateway 时插件不强制 key;指向远端 gateway 时才需要。
- **怎么加模型?** `raincode setup`(或编辑 `~/.raincode/profiles.toml` 后重启 gateway)。
- **支持并行工具调用吗?** 支持:多个工具调用按 index 分块,参数分片按 index 累积,
  不会被合并或丢参数。

## License

MIT
