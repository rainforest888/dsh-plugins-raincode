# dsh-raincode

让 **raincode** 成为 **DeepSeek Harness (dsh)** 的模型层:低价模型池 + StablePrefix
prompt 缓存 + 重试/故障转移,由本地 OpenAI 兼容网关(Rust)驱动,并以 dsh 插件形式发布。

一个仓库,两半:

| 部分 | 语言 | 角色 |
|---|---|---|
| [`packages/`](./packages) | TypeScript | dsh 插件("嘴")——把 dsh 的 `GenerateOptions` 翻译成 OpenAI wire 格式并流式回传,自动拉起网关 |
| [`crates/`](./crates) | Rust | raincode 网关("脑")——模型池、prompt 缓存、重试/故障转移、技能网络、能力刷新 |

插件本身不持有模型逻辑。

## 它能做什么

- 透明接管(尽力而为):dsh 中模型属于模型池的 chat 请求由 raincode 适配器承接;dsh
  能暴露当前模型时自动推导对应 profile,否则配置 `mainModel` 或 `role: main` 的 profile。
- 通过 dsh 插件设置配置模型池(profile 带 `role: main | subagent | any` 与方向 `tags`)。
- 从 OpenRouter、DeepSWE 与 opencode 用量榜刷新模型能力(top 15 每周刷新;其余模型按需刷新)。
- prompt 缓存、重试与 provider 故障转移(`rc-pro`)。
- 技能网络:技能以空壳 DAG 索引、逐层下钻到短清单;`raincode_learn` 把会话沉淀为经评审的技能。
- 请求日志与状态(`/requests`、`raincode_status`)。

## 包一览

| 包 | 定位 | 工具 / 命令 |
|---|---|---|
| [`dsh-plugins-raincode-skill`](./packages/plugin-skill) | skill 自进化网络——浏览 / 搜索 / 加载 raincode 技能,并把经验沉淀为 SKILL.md | `/skills`、`raincode_skill_search`、`raincode_skill_load`、`raincode_learn`、`raincode_status` |
| [`dsh-plugins-raincode-routing`](./packages/plugin-routing) | 模型自动路由——强主控模型分解大任务,按方向派发低价子代理 | `raincode_route`、`raincode_agent_tree`、`raincode_refresh_model`、`raincode_status` |
| [`@raincode-dsh/core`](./packages/core) | 共享适配核心(OpenAI wire 序列化、SSE 翻译、网关自动拉起);发布供两个插件独立解析 | — |

## 网关 crate

| crate | 职责 |
|---|---|
| `rc-pro` | OpenAI / Anthropic / 兼容 provider、缓存键、重试 |
| `rc-profile` | 模型池注册表与 key 管理 |
| `rc-gateway` | 无头 HTTP 网关 |
| `rc-capability` | 多来源模型能力刷新与评分 |
| `rc-skill` | `SKILL.md` 存储、DAG 网络、路由与导航 |
| `rc-state` | skills / 导航 / 模型 profile 的 SQLite 持久化 |
| `rc-cli` | `raincode proxy` + 非交互式 profile / skill 命令 |

## 目录

```text
packages/
  core/            共享适配核心(adapter、serialize、translate、sse、gateway manager)
  plugin-skill/    dsh-plugins-raincode-skill
  plugin-routing/  dsh-plugins-raincode-routing
crates/            Rust workspace(见上表)
skills/            技能网络随附的 SKILL.md 剧本
agents/            agent 角色提示词(architect / coding / researcher)
docs/superpowers/  设计规格与实现计划
handoff/           交接记录与项目历史
install.sh         构建并安装 raincode CLI(macOS / Linux)
install.ps1        构建并安装 raincode CLI(Windows)
```

## 快速开始

前置:网关需要 Rust `>= 1.75`;构建/运行插件需要 dsh `>= 0.2.2-rc.1` 与 Node.js `>= 22.19`。

1. 安装 raincode CLI(`>= 0.1.0`):`cargo install --path crates/rc-cli`(或 `./install.sh` / `install.ps1`)。
2. 配置模型池:`raincode setup`(写入 `~/.raincode/profiles.toml`)。
3. 启动网关:`raincode proxy --port 8787`,验证
   `curl http://127.0.0.1:8787/health` → `{"ok":true,"service":"raincode-gateway"}`。

## 在 dsh 中安装

需要 dsh `>= 0.2.2-rc.1`,API 差异与验证记录见
[`docs/COMPATIBILITY.md`](./docs/COMPATIBILITY.md)。

开发中的仓库可直接把两个插件包 link 进 profile(0.2.2 移植就是这样验证的):

```bash
dsh plugin --profile my-profile add \
  "link:$PWD/packages/plugin-routing" \
  "link:$PWD/packages/plugin-skill"
```

每个包都带 `cordis.patch.yml`,并在 `package.json` 里通过 `dsh.bundle.patch` 声明;
包进入 `dsh.profile.bundles` 后会自动插入 loader 行:

```yaml
- insert:
    - id: dsh-plugins-raincode-routing
      name: dsh-plugins-raincode-routing
    - id: dsh-plugins-raincode-skill
      name: dsh-plugins-raincode-skill
```

不启动应用即可校验:

```bash
dsh --profile my-profile --dump-config | tail -20
```

设置项会以这两个 id 出现在 dsh 设置界面。字段是 volatile 的,改完下一次请求即生效,
无需重启。`spawnGateway` 开启时按需拉起网关,二进制查找顺序为:`gatewayBin` 设置 →
`RAINCODE_BIN` → 仓库内 `target/release/raincode` → `~/.raincode/bin` → `PATH`,
因此在本仓库执行 `cargo build --release` 即可。

## 开发

```bash
# TypeScript 插件
npm install            # 通过 workspaces 把 @raincode-dsh/core 链进每个插件
npm run build          # 依次构建 core、plugin-skill、plugin-routing
npm test               # 运行每个包的 vitest 套件

# Rust 网关
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

构建 release 二进制:`npm run backend:build`(或 `cargo build --release`)。

## 文档与历史

- `docs/superpowers/specs/` — 网关与插件的设计文档。
- `docs/superpowers/plans/` — 实现计划(含 `tools/enrich_models.py` 背后的能力评分补充计划)。
- [`docs/COMPATIBILITY.md`](./docs/COMPATIBILITY.md) — dsh 0.2.2 API 面、变更点与本仓库的适配。
- [`docs/COMPETITORS.md`](./docs/COMPETITORS.md) — 同类 dsh 插件对比与 raincode 的差异。
- `handoff/` — 交接记录,以及此前多代理重构失败的事后复盘。
- `skills/` — 默认技能剧本;`agents/` — 供 dsh 子代理使用的角色提示词。

## License

MIT
