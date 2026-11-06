# Handoff —— dsh 插件(raincode 作为 DeepSeek Harness 模型层)

> 日期:2026-08-13
> 状态:**设计与计划已完成,实现未开始**。本文件是给下一个会话/代理的交接,读到它就能直接开工,无需重做研究。

---

## 一、目标(一句话)

做一个真正的 dsh 插件 `dsh-plugins-raincode`,让 dsh(DeepSeek Harness)的模型层 = raincode(低价模型池 + StablePrefix 缓存 + 重试),并在 dsh 内能**选择模型**、能 **`/skills` 查看 raincode skill 库**。交付:GitHub `rainforest888/dsh-plugins-raincode` + npm `dsh-plugins-raincode`。

## 二、当前状态

- ✅ 规格已批准并提交:`docs/superpowers/specs/2026-08-13-dsh-plugin-design.md`
- ✅ 实现计划已提交:`docs/superpowers/plans/2026-08-13-dsh-plugin.md`(12 个任务,TDD)
- ✅ npm 已登录(rainforest888);GitHub `gh` 已登录(rainforest888)
- ⬜ 实现:未开始
- ⬜ 建仓/发布:未开始(外向动作,动手前先与用户确认)

## 三、关键决策(已定,勿推翻)

1. 形态=**gateway(脑,Rust)+ 插件(嘴,TS)**;插件不持有模型逻辑。
2. 模型选择 = **精确映射**:dsh 模型选择器里的 model → gateway 按 `profile.model`/`profile.id` 选 profile。
3. skill 查看 = **`/skills` 命令**(无参=列清单,`/skills <name>`=看正文),数据走 gateway `/skills`(Rust 侧 `SkillStore::discover`,TS 不重复解析 SKILL.md)。
4. v1 **不做**:raincode `route` 自动拆解、skill 导航自动注入 dsh agent、gateway 鉴权/TLS、`/v1/messages` 改动。

## 四、已核实的非显然事实(省去重做研究)

### dsh 插件契约
- 插件文件导出:`name`、`inject`、`Config`(schemastery z schema)、`apply(ctx, config)`。
- `LlmAdapter` 基类(`@deepseek-ai/dsh-llm`,源码 index.ts ~L180):`providerInfo` / `providerRetryPolicy` / `listModels` / `resolveModel` / **`abstract stream(options): AsyncIterable<StreamChunk>`**(唯一必须)。
- 注册:`ctx.llm.registerAdapter([route], adapter)` 返回 handle(有 `.replace(providers)`);`ctx.llm.registerConfigurableProviders([{provider,displayName,settingsNs,settingsPath}])`。
- `StreamChunk`:`block-start`/`text-delta`/`reasoning-delta`/`tool-call-delta`/`block-end`/`usage`/`finish`。**硬契约:usage 先于 finish,finish 后无输出;tool-call `arguments` 是原始 JSON 串;缺 `[DONE]` → `STREAM_CLOSED`**。
- `GenerateOptions`:provider/model/reasoningEffort/messages/system/tools/temperature/maxTokens/stop/signal/sessionId/purpose。
- `Message`:`role: system|user|assistant` + `content: ContentBlock[]` + `source`;ContentBlock types = text/reasoning/image/tool-call/tool-result。
- 命令:`ctx.commands.register({name, description, input?, handler(inv): CommandResult|Promise<CommandResult>})`;`CommandResult = {kind:'success', text?}|{kind:'error', text}`。
- 参考实现(照抄布局):dsh monorepo `packages/llm/llm-deepseek`(直接 fetch DeepSeek OpenAI 兼容端 + `eventsource-parser`;文件 serialize/sse/translate/adapter/index)。

### npm 版本(已核实,注意 rc 预发布)
`@deepseek-ai/dsh@0.1.0-rc.6`、`dsh-llm@0.0.1-rc.1`、`dsh-llm-deepseek@0.0.1-rc.1`、`dsh-commands@0.0.1-rc.1`、`dsh-credentials@0.0.1-rc.1`、`dsh-launch-environment@0.0.1-rc.3`、`dsh-invariants@0.0.1-rc.1`、`dsh-settings@0.0.1-rc.1`、`dsh-timeout@0.0.1-rc.1`、`dsh-anonymous-user-id@0.0.1-rc.5`、`cordis@4.0.1`、`schemastery@3.18.1`。
⚠️ **semver 陷阱**:`^0.0.1` 不匹配 `0.0.1-rc.1`(预发布 < 正式),peerDeps 用精确版本。

### gateway 现状与缺口(`crates/rc-gateway/src/server.rs`)
- 现状端点:`/health`、`/v1/chat/completions`、`/v1/embeddings`、`/v1/messages`(Anthropic)、`/switch`。
- 缺口 1:流式 Finish 只发空 delta + finish_reason,**无 usage、无 `data: [DONE]`**。
- 缺口 2:工具调用 `index` 恒 0。
- 缺口 3:`ChatBody` 未解析 `stop`/`reasoning_effort`/`thinking`。
- 缺口 4:每请求固定 active profile,`model` 字段只回显不选路。
- 无 `/v1/models`、无 `/skills`。
- `GatewayConfig { addr(默认 127.0.0.1:4040), registry_path }`;rc-cli `Command::Proxy`(默认端口 8787)构造它 → 加字段要同步改 `crates/rc-cli/src/main.rs`。

### rc-pro 事实(`crates/rc-pro`)
- `CanonicalRequest.extra: Value` —— 目前只被 openai provider 读 `extra.session_id` → `prompt_cache_key`;**不转发** stop/reasoning_effort(需在 `build_chat_body` 补)。
- `build_chat_body(req, wire_model)` 是纯函数,好加透传。
- `ProvEvent::Finish { stop_reason, usage: Option<Value> }`。
- `map_chat_sse` 的 unfold 状态是 4 元组 `(sse, BTreeMap<usize,ToolAccum>, VecDeque<pending>, next_idx)`;**不捕获尾随 usage-only chunk**(choices 为空的 usage 会丢)——要加 `last_usage`。
- `Provider::stream(req) -> Result<ProvStream, ProviderError>`;`ProviderError::Http{status,body}`。

### rc-skill
- `SkillStore::new(root).discover() -> Vec<Skill>`;skill 文件 = `SKILL.md` + YAML frontmatter(与 dsh 的 skill 约定一致)。
- 默认目录 `~/.raincode/skills/`。

### 本机环境
- `~/.raincode/profiles.toml`:active=deepseek-v4-flash;3 profiles(deepseek-v4-flash / qwen3.8-max / mimo-v2.5)全走 `https://opencode.ai/zen/go/v1`,同一个 key。
- Node 24.18 / pnpm 11.9 / npm 11.16;**dsh 未安装**(端到端可选用 `npx @deepseek-ai/dsh web` 或源码 clone+pnpm)。
- raincode 已装(`~/.raincode/bin/raincode` + target/debug|release)。

## 五、凭据与安全

- GitHub `gh`:rainforest888(scopes gist/read:org/repo,**无 admin:org** → 建不了 org)。
- npm:已登录 rainforest888;**账户开邮箱 OTP**,以后 `npm publish` 可能仍需 OTP(让用户从邮箱取码)。
- ⚠️ **安全提醒(重要)**:用户曾把 npm 密码发在对话里。已提醒:①npm 开 2FA;②改密码;③密码<redacted> 一律**不写入任何文件/记忆**。发布只写 token(`~/.npmrc`)。
- repo 命名:`rainforest888/dsh-plugins-raincode`;topics 18 个(`dsh-plugin` 打头,清单见规格 §7);npm 名 `dsh-plugins-raincode`(已核实可用)。

## 六、下一步(执行计划)

按 `docs/superpowers/plans/2026-08-13-dsh-plugin.md` 的 12 个任务执行:

| 任务 | 内容 | 位置 |
|---|---|---|
| 1 | 基线验证(cargo test rc-pro/rc-gateway) | raincode 仓库 |
| 2 | rc-pro:透传 stop/reasoning_effort + 尾随 usage | `crates/rc-pro/src/openai.rs` |
| 3 | gateway:流式 usage+`[DONE]`+工具 index | `crates/rc-gateway/src/server.rs` |
| 4 | gateway:按 model 选 profile + `/v1/models` + `/skills` | `crates/rc-gateway` + rc-cli |
| 5 | TS 脚手架 | `G:/claude codex_workspace/dsh-plugins-raincode` |
| 6 | serialize.ts | 同上 |
| 7 | translate.ts | 同上 |
| 8 | adapter.ts(stream/listModels/resolveModel)+ sse.ts | 同上 |
| 9 | index.ts + commands.ts(`/skills`) | 同上 |
| 10 | README + wire 级端到端 | 同上 |
| 11 | GitHub 建仓 + topics(`gh repo create` 后 `gh repo edit`) | GitHub |
| 12 | npm publish(需确认 + 可能 OTP) | npm |

**执行纪律(用户上次多代理迭代翻车的教训,见 `handoff/iter-plan-and-step1-2.md`)**:子代理「完成」报告不可信,每步必须用真实 `cargo test`/`npm test` 输出实证;依赖是全局共享资源,禁止删 workspace.dependencies 里其他 crate 仍用的项;外向动作(建仓/发布)先确认再动手。**建议本会话内联执行**,不走多代理。
