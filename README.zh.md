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

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `baseURL` | `http://127.0.0.1:8787` | raincode gateway 地址 |
| `apiKeyEnv` | `RAINCODE_API_KEY` | 仅满足 dsh 凭据接缝;本地 loopback gateway 不校验 key(缺失也不报错) |
| `models` | `[]` | 可选静态目录覆盖;缺省自动从 gateway `/v1/models` 拉取模型池 |
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

- **gateway 没启动?** 模型调用会报 TRANSPORT 类错误。先 `raincode proxy --port 8787`。
- **为什么 API key 是摆设?** 本地 loopback gateway 信任本机,真实上游 key 从
  `~/.raincode/profiles.toml` 解析(支持 api_key / api_key_file / api_key_env)。
  指向本机 gateway 时插件不强制 key;指向远端 gateway 时才需要。
- **怎么加模型?** `raincode setup`(或编辑 `~/.raincode/profiles.toml` 后重启 gateway)。
- **支持并行工具调用吗?** 支持:多个工具调用按 index 分块,参数分片按 index 累积,
  不会被合并或丢参数。

## License

MIT
