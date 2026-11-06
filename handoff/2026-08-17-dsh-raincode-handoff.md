# Handoff —— dsh-raincode（raincode 彻底适配 DeepSeek Harness）

日期：2026-08-17
状态：核心改造已完成，真实 dsh 链路测试尚未通过（详见 §9 当前问题）。

---

## 1. 项目定位（最终方向）

raincode 不再作为独立 agent harness / TUI 使用，而是 **dsh 的经济型模型层 + 自学习 skill 网络**：

```text
chat 模型(dsh 当前交互模型) = 调度/监管/汇报
raincode 主控模型(强/贵)      = 拆解任务、按方向派活、审查
子代理/孙代理(便宜,方向标签)  = 具体执行
```

- 默认 autoRoute 策略为 **suggest**：只有明显大任务时 chat 模型才询问用户是否启动 route；小任务不启动。
- 用户可显式说“用 raincode / 派活给 raincode”强制启动。
- route 的执行完全走 dsh 原生 subagent seam（方案 B），raincode 不保留自己的 agent 循环。

---

## 2. 代码仓库结构（已裁剪）

`raincode-iter` 已重命名为 `dsh-raincode`。Rust workspace 只剩 7 个 crate：

| crate | 职责 |
|---|---|
| `rc-pro` | OpenAI/Anthropic/兼容 provider、缓存键、重试 |
| `rc-profile` | 模型池 registry + key 管理 |
| `rc-gateway` | headless HTTP gateway |
| `rc-capability` | 多源模型能力刷新与综合评分 |
| `rc-skill` | SKILL.md 存储、DAG 网络、router、navigator |
| `rc-state` | SQLite 持久化（skill/model profile/导航记录） |
| `rc-cli` | `raincode proxy` + profiles/skills/model/setup 命令 |

已删除：
`tui/`、`rc-core`、`rc-router`、`rc-evolve`、`rc-orchestrate`、
`rc-sandbox`、`rc-tool`、`rc-mcp`、`rc-net`、`rc-proto`，
以及 `rc-cli` 的 `profiles enrich` research-agent 模块（`crates/rc-cli/src/enrich.rs`）。

> 说明：rc-evolve 的学习逻辑没有完整迁到 gateway；当前 gateway `/learn`
> 是一个轻量替代（见 §5.3），不是原 EvolveEngine 全量迁移。

---

## 3. dsh 插件仓库

插件在独立目录 `G:/claude codex_workspace/dsh-plugins-raincode`（本仓库的兄弟目录，独立 git repo）。

插件模块：

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 插件入口、Config schema、LlmAdapter、settings、无感绑定、工具注册 |
| `src/adapter.ts` | `RaincodeAdapter`：模型发现 + 流式调用 |
| `src/serialize.ts` / `src/translate.ts` / `src/sse.ts` | dsh ↔ OpenAI wire |
| `src/gateway.ts` | spawn gateway、registry 写入、/profiles 同步 |
| `src/route.ts` | `raincode_route`（通过 `ctx.subagents.start` 启动主控子代理） |
| `src/agent-tree.ts` | `raincode_agent_tree`（父子代理树） |
| `src/status.ts` | `raincode_status` |
| `src/skill-tools.ts` | `raincode_skill_search` / `raincode_skill_load` |
| `src/learn.ts` | `raincode_learn` |
| `src/tools.ts` | `raincode_refresh_model` |
| `src/commands.ts` | `/skills` 命令 |

插件工具清单：

| 工具 | 触发 |
|---|---|
| `raincode_route` | 大任务（chat 先询问）或用户主动要求 |
| `raincode_agent_tree` | “哪个子代理派了哪些孙代理” |
| `raincode_refresh_model` | “帮我查看 xx 模型的能力” |
| `raincode_learn` | “学习一下这次任务 / 沉淀成 skill” |
| `raincode_status` | raincode 状态 / 子代理工作状况 / token 用量 |
| `raincode_skill_search` / `raincode_skill_load` | skill 网络按需使用 |

---

## 4. Gateway 端点

| 端点 | 方法 | 状态 |
|---|---|---|
| `/health` | GET | ✅ |
| `/v1/chat/completions` | POST | ✅（OpenAI 兼容流式 + usage + [DONE] + 工具 index） |
| `/v1/models` | GET | ✅ |
| `/v1/messages` | POST | ✅（Anthropic 兼容） |
| `/v1/embeddings` | POST | ✅ |
| `/skills` | GET | ✅（列表/正文） |
| `/profiles` | GET/PUT | ✅（模型池同步） |
| `/capabilities` | GET | ✅（缓存能力档案） |
| `/capabilities/refresh` | POST | ✅（单模型手动刷新） |
| `/capabilities/refresh-top` | POST | ✅（opencode 前 N 刷新） |
| `/requests` | GET | ✅（最近 200 条请求日志） |
| `/learn` | POST | ✅（轻量学习：主控模型生成 SKILL.md，进 review 区） |
| `/switch` | POST | ✅ |
| `/skills/search` | GET | ❌ 未实现（插件端目前用 `/skills` 全量 + 本地过滤） |
| `/skills/nav` | GET/POST | ❌ 未实现 |

---

## 5. 关键机制

### 5.1 无感绑定 chat 模型

- 插件读取 dsh settings 的 `agent-default-model`；
- `deepseek-official` → 自动生成 raincode profile（官方 baseURL + `DEEPSEEK_API_KEY`）；
- 插件通过 `llm/stream` waterfall 拦截普通对话请求，让 raincode chat 模型跟随 dsh 当前模型；
- 对 `provider=raincode` 的请求，也必须先 `sync()` 确保 gateway 已拉起（这是 2026-08-17 修复的 bug）。

### 5.2 spawnGateway

- `Config.spawnGateway` 默认 true；
- 插件启动/首次调用时写 `%TEMP%/raincode-dsh/profiles.toml`，然后 `spawn('raincode', ['proxy','--port',port,'--registry-path',...])`；
- spawn 监听 `error`/`spawn` 事件，避免二进制缺失造成未捕获异常；
- dsh 卸载插件时 kill 子进程；
- **关键**：spawn 使用 PATH 中的 `raincode`。PATH 上可能是旧二进制，见 §9 问题 1。

### 5.3 raincode_learn（轻量版）

- `POST /learn {task, transcript?, category?}`；
- 用当前 active profile 调模型生成合法 SKILL.md（frontmatter + ≤20 行 checklist）；
- 强制 `scope=review`，写进 `~/.raincode/skills/.review/`，用户 approve 后转正；
- 这是轻量替代，不等价于已删除的 rc-evolve 完整 EvolveEngine。

### 5.4 模型能力刷新

- 数据源：
  - OpenRouter `/api/v1/models`（AA intelligence/coding/agentic + design_arena 25 类方向 + 定价）；
  - DeepSWE 官方页（Pass@1 + 平均成本 + 输出 token + 步数）；
  - opencode `/data`（token 调用量 leaderboard 前 15）；
  - DeepSeek 官方报告（HF README 的 HLE/SWE 系列）。
- 网络策略：直连失败后走 Clash 代理（`RAINCODE_HTTP_PROXY`，默认 `http://127.0.0.1:7890`）；host 记忆避免重复 30s 直连超时。
- 周更：gateway 启动后每 7 天自动刷新 opencode 前 15。
- 官方报告源：**按用户要求暂时不要动**。目前只有 DeepSeek；GLM/Kimi/Qwen 文本型未接；MiniMax/MiMo 是图片型报告，等视觉插件能力再说。

### 5.5 模型池 role/tags

- 插件 settings 的 profile schema 已支持：
  - `role: main | subagent | any`
  - `tags: string[]`
- Rust 侧 `rc-profile::Profile` 尚未持久化 role/tags（PUT /profiles 会忽略未知字段）；后续需要扩展。

### 5.6 孙代理 UI

- 采用 dsh 原生 Web UI subagent catalog：父→子→孙逐层展开，点击任意深度打开 child；
- raincode 只保证所有层级走 dsh 原生 subagent seam；
- `raincode_agent_tree` 是模型侧补充，输出明确父子关系文本。

---

## 6. 当前用户 dsh 配置状态（重要）

以下是为测试做的临时改动，**重启/恢复前先看这里**：

- `~/.dsh/profiles/web/cordis.patch.yml`：已恢复启用 raincode（`spawnGateway: true`），并有备份 `cordis.patch.yml.bak-*`。
- `~/.dsh/settings.yaml`：临时把 `agent-presets.default` 从 `anchored-standard` 改成 `standard`，用于 headless 测试完整工具目录；备份 `~/.dsh/settings.yaml.bak-raincode-test`。**测试结束后应恢复为 anchored-standard**（或用户确认要 standard）。
- `~/.dsh/profiles/headless/package.json`：临时加了本地 file 依赖 `dsh-plugins-raincode`；备份 `package.json.bak-raincode-test`。
- `~/.dsh/profiles/headless/cordis.patch.yml`：临时插入 raincode 行；备份 `cordis.patch.yml.bak-raincode-test`。
- `~/.raincode/bin/raincode.exe`：已被替换为新构建的 debug 二进制；旧版备份 `raincode.exe.bak-*`。
- 插件新版 lib 已复制到：
  - `~/.dsh/profiles/web/node_modules/dsh-plugins-raincode/lib/`
  - `~/.dsh/profiles/headless/node_modules/dsh-plugins-raincode/lib/`
- 用户需要**完全重启 dsh web** 才能加载新版插件。

---

## 7. 构建与测试命令

### Rust

```bash
cd /g/claude codex_workspace/dsh-raincode
cargo test --workspace
cargo clippy --workspace --all-targets
cargo build -p rc-cli
```

当前状态：全部通过，clippy 0 warning。

### 插件

```bash
cd /g/claude codex_workspace/dsh-plugins-raincode
npx tsc --noEmit
npm test -- --run
npm run build
```

当前状态：29 个测试全部通过。

---

## 8. 已完成事项清单

- [x] 方案 B 确定：route 执行在 dsh subagent seam，删除 Rust 独立执行栈。
- [x] 删除 TUI 与交互式 CLI 命令。
- [x] `spawnGateway` + registry 文件写入 + spawn 错误处理。
- [x] 无感绑定 dsh 当前模型。
- [x] 模型池 profiles schema（role/tags/secret key）。
- [x] `raincode_route` 工具（`ctx.subagents.start`）。
- [x] `raincode_agent_tree` 工具（`listDescendants` 父子关系）。
- [x] 能力刷新引擎（OpenRouter/DeepSWE/opencode/DeepSeek 官方报告）。
- [x] `/requests` 请求日志 + `raincode_status`。
- [x] `raincode_skill_search/load`。
- [x] `raincode_learn` + gateway `/learn`。
- [x] 删除 rc-core/rc-router/rc-evolve/rc-orchestrate/rc-sandbox/rc-tool/rc-mcp/rc-net/rc-proto。
- [x] 根 README 重写为新架构。

---

## 9. 当前问题（接手必读）

### 问题 1：PATH 上的 raincode 可能是旧二进制

- 插件 spawn 使用 PATH 里的 `raincode`；
- 8 月 12 日安装的 `~/.raincode/bin/raincode.exe` 没有 `/requests`、`/profiles`、`/capabilities` 等新端点；
- 已把 `target/debug/raincode.exe` 覆盖到 `~/.raincode/bin/raincode.exe`（旧版有 .bak），但**还没有完成一次成功测试**。

### 问题 2：真实 headless 测试仍失败

最后一次执行：

```bash
dsh --profile headless "用 raincode route 测试子代理链路 ..."
```

结果：`exit 1` 且 stdout/stderr 为空。

之前一次测试（旧 gateway 二进制时）返回：

```text
raincode_route stopped with error
raincode_status: /requests /profiles /capabilities 全部 404
没有派发任何子代理/孙代理
```

已做修复：
- `provider=raincode` 的 `llm/stream` 现在也会先 `sync()` 拉起 gateway；
- gateway 二进制已替换为新版。

仍需继续排查：
- headless 任务 exit 1 无输出的原因（可能插件配置/schema 校验失败、subagents 服务缺失、headless preset 工具目录问题等）；
- 先跑 `dsh --profile headless --dump-config`（目前可以成功），确认 raincode 行存在；
- 再跑简单 `dsh --profile headless "hello"`（目前可以成功）；
- 然后逐步构造最小 route 测试，查看插件日志。

### 问题 3：测试用临时配置需要恢复

见 §6。尤其是 `settings.yaml` 的 default preset 和 headless profile 临时依赖。

### 问题 4：未验证项

- 真实 dsh web 中 `raincode_route` 的子代理/孙代理链路；
- `raincode_learn` 真实生成 skill + review approve；
- `/requests` 日志在主控/子代理调用中的真实内容；
- `rc-profile` 持久化 role/tags；
- gateway `/skills/search`、`/skills/nav` 未实现。

---

## 10. 下一步建议顺序

1. 恢复 §6 中不必要的临时配置（先问用户是否保留 standard preset）。
2. 在真实 dsh web（完全重启后）做最小验收：
   - 简单对话（chat 绑定是否正常）；
   - `raincode_status`；
   - `raincode_route` 只发 hello 的链路测试（子代理 + 孙代理）。
3. 修复 headless exit 1 问题（先看 dsh 日志/插件加载日志）。
4. 扩展 `rc-profile` 的 role/tags 持久化。
5. 官方报告源（等用户指示再动）。
6. skill 网络更完整的 gateway 端点（`/skills/search`、`/skills/nav`）与自学习闭环增强。
7. 发布前：GitHub 建仓、npm publish（用户明确要求**暂时不要**）。

---

## 11. 安全与发布边界

- 不要推送 GitHub，不要 npm publish（用户明确要求）。
- 本地 Git remote 仍是 `G:\claude codex_workspace\raincode`；本 handoff 提交只做本地 commit。
- `.credentials.yaml` / API key 不得写入仓库或 handoff。
- `dsh-anchored-standard/` 是嵌套独立 git repo，本次提交不纳入父仓库。
- `tools/*.ps1` 是临时脚本，本次提交不纳入。
