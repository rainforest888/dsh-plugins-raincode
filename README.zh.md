# dsh-raincode

让 **raincode** 成为 **DeepSeek Harness (dsh)** 的模型层:低价模型池 + StablePrefix
prompt 缓存 + 重试/故障转移,由本地 OpenAI 兼容网关(Rust)驱动。

本仓库是 raincode 的 **dsh 插件 monorepo**,把该能力拆成两个独立发布的 dsh 插件,
共享 `packages/core` 适配核心。

## 包一览

| 包 | 定位 | 工具 / 命令 |
|---|---|---|
| [`dsh-plugins-raincode-skill`](./packages/plugin-skill) | skill 自进化网络——浏览 / 搜索 / 加载 raincode 技能,并把经验沉淀为 SKILL.md | `/skills`、`raincode_skill_search`、`raincode_skill_load`、`raincode_learn`、`raincode_status` |
| [`dsh-plugins-raincode-routing`](./packages/plugin-routing) | 模型自动路由——强主控模型分解大任务,按方向派发低价子代理 | `raincode_route`、`raincode_agent_tree`、`raincode_refresh_model`、`raincode_status` |
| [`@raincode-dsh/core`](./packages/core) | 共享适配核心(OpenAI wire 序列化、SSE 翻译、网关自动拉起);发布供两个插件独立解析 | — |

## 架构

插件是"嘴":把 dsh 的 `GenerateOptions` 翻译成 OpenAI wire 格式并流式回传;
raincode 网关(Rust)是"脑":负责 profile 选择、prompt 缓存、重试与故障转移。
插件本身不持有模型逻辑。

## 目录

```
packages/
  core/            共享适配核心(adapter、serialize、translate、sse、gateway manager)
  plugin-skill/    dsh-plugins-raincode-skill
  plugin-routing/  dsh-plugins-raincode-routing
```

## 快速开始

1. 安装 raincode CLI(`>= 0.1.0`):`cargo install --path crates/rc-cli`(或 `./install.sh`)。
2. 配置模型池:`raincode setup`(写入 `~/.raincode/profiles.toml`)。
3. 启动网关:`raincode proxy --port 8787`,验证
   `curl http://127.0.0.1:8787/health` → `{"ok":true,"service":"raincode-gateway"}`。

## 在 dsh 中安装

```bash
dsh plugin --profile web add dsh-plugins-raincode-skill
dsh plugin --profile web add dsh-plugins-raincode-routing
```

再在 profile 的 patch 层(`~/.dsh/profiles/web/cordis.patch.yml`)为每个插件加入对应行:

```yaml
- insert:
    - id: raincode-skill
      name: dsh-plugins-raincode-skill
      config:
        baseURL: http://127.0.0.1:8787
        apiKeyEnv: RAINCODE_API_KEY
    - id: raincode-routing
      name: dsh-plugins-raincode-routing
      config:
        baseURL: http://127.0.0.1:8787
        apiKeyEnv: RAINCODE_API_KEY
```

重启 `dsh web` 生效。每个插件自带 README(中英),说明前置条件、dsh 安装、
配置字段与提供的工具。

## 开发

```bash
npm install            # 通过 workspaces 把 @raincode-dsh/core 链进每个插件
npm run build          # 依次构建 core、plugin-skill、plugin-routing
npm test               # 运行每个包的 vitest 套件
```

## License

MIT
