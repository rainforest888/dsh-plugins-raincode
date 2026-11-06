# dsh 插件(raincode 模型层)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 DeepSeek Harness(dsh)的模型层 = raincode(模型池 + 缓存 + 重试),并在 dsh 内可**选择模型**、可 **`/skills` 查看 raincode skill 库**;插件发布为 npm `dsh-plugins-raincode`、GitHub `rainforest888/dsh-plugins-raincode`。

**Architecture:** 双层。Rust 侧(`crates/rc-gateway`)是「脑」——按 `model` 选 profile、流式 wire 补齐(`[DONE]`/usage/工具 index)、`/v1/models`、`/skills`;TS 侧(`dsh-plugins-raincode` 插件)是「嘴」——把 dsh `GenerateOptions` 序列化成 OpenAI wire 调 gateway,把 OpenAI chunk 翻译回 dsh `StreamChunk`,并注册 `/skills` 命令。插件不持有模型逻辑。

**Tech Stack:** Rust(axum / tokio / futures / serde_json)、TypeScript(NodeNext ESM)、`@deepseek-ai/dsh-llm`、`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-commands`、`eventsource-parser`、vitest。

## Global Constraints

- 规格文档:`docs/superpowers/specs/2026-08-13-dsh-plugin-design.md`(交付/topics/npm 名见其 §7)。
- Rust 工作区位于 `G:/claude codex_workspace/raincode-iter`,git 分支 `master`,已有已提交规格。
- TS 插件目录:新建 `G:/claude codex_workspace/dsh-plugins-raincode`(raincode 仓库的**兄弟目录**,独立 git 仓库),最终推送 GitHub。
- dsh `StreamChunk` 契约(硬性):usage **必须**先于 finish;finish 之后不再有输出;`tool-call` 的 `arguments` 是**原始 JSON 串**;缺 `[DONE]` → `STREAM_CLOSED`。
- npm 账号 `rainforest888` 已登录(验证过 `npm whoami`)。**发布前确认**用户同意;密码<redacted> 一律不写入任何文件。
- 依赖精确版本(npm 已核实):`@deepseek-ai/dsh-llm@0.0.1-rc.1`、`@deepseek-ai/cordis@4.0.1`、`@deepseek-ai/schemastery@3.18.1`、`@deepseek-ai/dsh-commands@0.0.1-rc.1`、`eventsource-parser@^3.1.0`、`@deepseek-ai/dsh-settings@0.0.1-rc.1`、`@deepseek-ai/dsh-credentials@0.0.1-rc.1`、`@deepseek-ai/dsh-launch-environment@0.0.1-rc.3`、`@deepseek-ai/dsh-invariants@0.0.1-rc.1`、`@deepseek-ai/dsh-timeout@0.0.1-rc.1`、`@deepseek-ai/dsh-anonymous-user-id@0.0.1-rc.5`。

---

## File Structure

### Rust(raincode 仓库)

| 文件 | 职责 |
|---|---|
| `crates/rc-pro/src/openai.rs` | `build_chat_body` 透传 `extra.stop`/`extra.reasoning_effort`;`map_chat_sse` 捕获尾随 usage |
| `crates/rc-gateway/src/server.rs` | 按 model 选 profile;流式 `[DONE]`+usage+工具 index;`/v1/models`;`/skills`;`GatewayConfig.skills_dir` |
| `crates/rc-gateway/Cargo.toml` | 加 `rc-skill`、`dirs` 依赖 |
| `crates/rc-cli/src/main.rs` | `Command::Proxy` 的 `GatewayConfig` 构造补 `skills_dir` |

### TS(新目录 `G:/claude codex_workspace/dsh-plugins-raincode`)

| 文件 | 职责 |
|---|---|
| `package.json` | 包元数据 / deps / peerDeps / exports |
| `tsconfig.json` | NodeNext ESM,emit `lib/` |
| `vitest.config.ts` | vitest 配置 |
| `src/serialize.ts` | dsh `GenerateOptions`/`Message` → OpenAI 请求体 |
| `src/sse.ts` | fetch + eventsource-parser,产出 SSE data 流 |
| `src/translate.ts` | OpenAI chunk → `StreamChunk`(block 组装) |
| `src/adapter.ts` | `RaincodeAdapter extends LlmAdapter`(stream/listModels/resolveModel) |
| `src/commands.ts` | `/skills` 命令 handler |
| `src/index.ts` | 插件入口:`Config`/`apply`/注册 |
| `src/*.spec.ts` | vitest 测试(serialize/translate/adapter/commands) |
| `README.md` / `LICENSE` | 文档 / MIT |

---

## Task 1: 基线验证(Rust 构建 + 现有测试)

**Files:**
- Run: workspace

- [ ] **Step 1: 构建并跑 rc-pro / rc-gateway 现有测试**

Run(在 `G:/claude codex_workspace/raincode-iter`):
```bash
cargo test -p rc-pro -p rc-gateway 2>&1 | tail -20
```
Expected: 全部 PASS(rc-pro 与 rc-gateway)。

- [ ] **Step 2: 记录 `raincode proxy` 现状**

```bash
cargo run -p rc-cli -- proxy --port 8799 &
sleep 3 && curl -s http://127.0.0.1:8799/health && kill %1
```
Expected: `{"ok":true,"service":"raincode-gateway"}`。确认现有 gateway 可启动(含默认 profile 无 key 时 /v1/models 不在,后面任务会加)。

- [ ] **Step 3: Commit(基线已确认,无需改动)**

```bash
git status --short
```
Expected: 干净(规格已提交)。

---

## Task 2: rc-pro —— 透传 `stop` / `reasoning_effort` + 捕获尾随 usage

**Files:**
- Modify: `crates/rc-pro/src/openai.rs`
- Test: `crates/rc-pro/src/openai.rs`(模块内 `#[cfg(test)]`)

**Interfaces:**
- Consumes: `CanonicalRequest.extra`(gateway 会把 `stop`/`reasoning_effort` 放进 extra)。
- Produces: `build_chat_body` 读 `extra.stop`(数组)→ 请求体 `stop`;读 `extra.reasoning_effort`(`!= "off"`)→ 请求体 `reasoning_effort`。`map_chat_sse` 的 `ProvEvent::Finish.usage` 对尾随 usage-only chunk 也有效。

- [ ] **Step 1: 写失败测试(加在 openai.rs 现有 test 模块)**

在 `crates/rc-pro/src/openai.rs` 的 `#[cfg(test)] mod tests` 中新增:
```rust
#[test]
fn chat_body_forwards_stop_and_reasoning_effort_from_extra() {
    let mut req = chat_request("sess-abc");
    req.extra = json!({"stop": ["END"], "reasoning_effort": "high"});
    let body = build_chat_body(&req, "wire-deepseek");
    assert_eq!(body["stop"], json!(["END"]));
    assert_eq!(body["reasoning_effort"], "high");
}

#[test]
fn chat_body_omits_reasoning_effort_when_off() {
    let mut req = chat_request("sess-abc");
    req.extra = json!({"reasoning_effort": "off"});
    let body = build_chat_body(&req, "wire-deepseek");
    assert!(body.get("reasoning_effort").is_none());
}
```
(`chat_request` 是现有 test 辅助函数,已有,直接复用。)

- [ ] **Step 2: 运行确认失败**

Run: `cargo test -p rc-pro chat_body_forwards_stop 2>&1 | tail -8`
Expected: FAIL(`body["stop"]` 不存在)。

- [ ] **Step 3: 实现 —— `build_chat_body` 透传**

在 `crates/rc-pro/src/openai.rs` 的 `build_chat_body`,紧接 `session_id` 块之后插入:
```rust
    // dsh/OpenAI 兼容客户端透传:gateway 把 stop / reasoning_effort 放进 extra。
    if let Some(stops) = req.extra.get("stop").and_then(Value::as_array) {
        let stops: Vec<String> = stops
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();
        if !stops.is_empty() {
            body["stop"] = json!(stops);
        }
    }
    if let Some(effort) = req.extra.get("reasoning_effort").and_then(Value::as_str) {
        // "off" → 显式关 thinking,不发射 reasoning_effort(DeepSeek 顶层字段)。
        if effort != "off" {
            body["reasoning_effort"] = json!(effort);
        }
    }
```

- [ ] **Step 4: 运行确认通过**

Run: `cargo test -p rc-pro chat_body_ 2>&1 | tail -6`
Expected: PASS(两个新测试)。

- [ ] **Step 5: 实现 —— `map_chat_sse` 捕获尾随 usage**

`map_chat_sse` 的 unfold 状态元组从 4 元组扩为 5 元组,加 `last_usage: Option<Value>`。**整函数替换**为:

```rust
fn map_chat_sse(
    sse: Pin<Box<dyn Stream<Item = Result<String, ProviderError>> + Send>>,
) -> ProvStream {
    // 状态 = (sse, 工具累积器, pending, 自增下标, last_usage)。
    // last_usage:DeepSeek 可能把 usage 放在尾随 usage-only chunk(choices 为空),
    // 不能只在 finish_reason 分支读 chunk.usage,否则该情况 usage 丢失。
    let state = (
        sse,
        BTreeMap::<usize, ToolAccum>::new(),
        std::collections::VecDeque::<Result<ProvEvent, ProviderError>>::new(),
        0usize,
        None::<Value>,
    );
    Box::pin(futures::stream::unfold(
        state,
        |(mut s, mut accs, mut pending, mut next_idx, mut last_usage)| async move {
            loop {
                if let Some(ev) = pending.pop_front() {
                    return Some((ev, (s, accs, pending, next_idx, last_usage)));
                }
                match s.next().await {
                    None => {
                        for acc in accs.values() {
                            if !acc.name.is_empty() {
                                let (id, name) = (acc.id.clone(), acc.name.clone());
                                let arguments = parse_tool_arguments(&acc.args)
                                    .unwrap_or(Value::Object(Default::default()));
                                pending.push_back(Ok(ProvEvent::ToolCall { id, name, arguments }));
                                pending.push_back(Ok(ProvEvent::ToolCallEnd { id: acc.id.clone() }));
                            }
                        }
                        accs.clear();
                        if pending.is_empty() {
                            return None;
                        }
                        if let Some(ev) = pending.pop_front() {
                            return Some((ev, (s, accs, pending, next_idx, last_usage)));
                        }
                        return None;
                    }
                    Some(Err(e)) => return Some((Err(e), (s, accs, pending, next_idx, last_usage))),
                    Some(Ok(line)) => {
                        let chunk: Value = match serde_json::from_str(&line) {
                            Ok(v) => v,
                            Err(_) => continue,
                        };
                        if let Some(u) = chunk.get("usage").cloned() {
                            last_usage = Some(u);
                        }
                        let choices = chunk["choices"].as_array().cloned().unwrap_or_default();
                        for choice in &choices {
                            let delta = &choice["delta"];
                            if let Some(text) = delta["content"].as_str() {
                                if !text.is_empty() {
                                    pending.push_back(Ok(ProvEvent::Delta {
                                        text: text.to_string(),
                                    }));
                                }
                            }
                            if let Some(text) = delta["reasoning_content"].as_str() {
                                if !text.is_empty() {
                                    pending.push_back(Ok(ProvEvent::Thinking {
                                        text: text.to_string(),
                                    }));
                                }
                            }
                            if let Some(tool_calls) = delta["tool_calls"].as_array() {
                                for tc in tool_calls {
                                    let fnv = &tc["function"];
                                    let has_start = tc["id"]
                                        .as_str()
                                        .map(|s| !s.is_empty())
                                        .unwrap_or(false)
                                        || fnv["name"]
                                            .as_str()
                                            .map(|s| !s.is_empty())
                                            .unwrap_or(false);
                                    let idx = tc["index"].as_u64().map(|i| i as usize).unwrap_or_else(|| {
                                        if has_start {
                                            let i = next_idx;
                                            next_idx += 1;
                                            i
                                        } else {
                                            accs.keys()
                                                .next_back()
                                                .copied()
                                                .unwrap_or_else(|| {
                                                    let i = next_idx;
                                                    next_idx += 1;
                                                    i
                                                })
                                        }
                                    });
                                    let acc = accs.entry(idx).or_insert_with(|| ToolAccum {
                                        id: tc["id"].as_str().unwrap_or_default().to_string(),
                                        name: fnv["name"].as_str().unwrap_or_default().to_string(),
                                        args: String::new(),
                                    });
                                    if let Some(id) = tc["id"].as_str() {
                                        if !id.is_empty() {
                                            acc.id = id.to_string();
                                        }
                                    }
                                    if let Some(name) = fnv["name"].as_str() {
                                        if !name.is_empty() {
                                            acc.name = name.to_string();
                                        }
                                    }
                                    if let Some(args) = fnv["arguments"].as_str() {
                                        if !args.is_empty() && acc.args.len() < MAX_TOOL_ARGS_BYTES {
                                            acc.args.push_str(args);
                                        }
                                    }
                                }
                            }
                            if let Some(reason) = choice["finish_reason"].as_str() {
                                if !reason.is_empty() {
                                    for acc in accs.values() {
                                        if !acc.name.is_empty() {
                                            let (id, name) = (acc.id.clone(), acc.name.clone());
                                            let arguments = parse_tool_arguments(&acc.args)
                                                .unwrap_or(Value::Object(Default::default()));
                                            pending.push_back(Ok(ProvEvent::ToolCall { id, name, arguments }));
                                            pending.push_back(Ok(ProvEvent::ToolCallEnd { id: acc.id.clone() }));
                                        }
                                    }
                                    accs.clear();
                                    pending.push_back(Ok(ProvEvent::Finish {
                                        stop_reason: reason.to_string(),
                                        usage: last_usage.take(),
                                    }));
                                }
                            }
                        }
                        continue;
                    }
                }
            }
        },
    ))
}
```
(相对原版的唯一改动:状态加 `last_usage`,每 chunk 顶部捕获 `chunk.usage`,finish 时用 `last_usage.take()`。)

- [ ] **Step 6: 跑 rc-pro 全量测试**

Run: `cargo test -p rc-pro 2>&1 | tail -10`
Expected: 全部 PASS(含既有工具调用/缓存测试)。

- [ ] **Step 7: Commit**

```bash
git add crates/rc-pro/src/openai.rs
git commit -m "feat(rc-pro): chat body 透传 stop/reasoning_effort;流式捕获尾随 usage"
```

---

## Task 3: gateway —— 流式 wire 补齐(`[DONE]` / usage / 工具 index)

**Files:**
- Modify: `crates/rc-gateway/src/server.rs`
- Test: `crates/rc-gateway/src/server.rs`(模块内 `#[cfg(test)]`)

**Interfaces:**
- Consumes: Task 2 的 `ProvEvent::Finish.usage`(已可靠);rc-pro `ProvEvent`/`ProviderError`。
- Produces: 流式 OpenAI 响应含 usage chunk → finish chunk → `data: [DONE]`;工具调用按 call id 递增 index。辅助函数 `stream_openai_events(stream, id, model)`(可单测)。

- [ ] **Step 1: 加 import**

在 `crates/rc-gateway/src/server.rs` 顶部,把 `use rc_pro::{create_provider, Provider, ProviderError};` 改为加 `use futures::Stream;`、`use std::collections::HashMap;`:
```rust
use futures::StreamExt;
use rc_pro::{create_provider, Provider, ProviderError};
use std::collections::HashMap;
use std::convert::Infallible;
```

- [ ] **Step 2: 写失败测试**

在 server.rs 的 `#[cfg(test)] mod tests` 中新增(用 `#[tokio::test]` + collect,不依赖 `futures::executor` feature):
```rust
use rc_pro::canonical::ProvEvent;
use rc_pro::ProviderError;
use futures::StreamExt;

#[tokio::test]
async fn stream_emits_usage_then_finish_then_done() {
    let events = vec![
        Ok::<ProvEvent, ProviderError>(ProvEvent::Delta { text: "hi".into() }),
        Ok(ProvEvent::Finish {
            stop_reason: "stop".into(),
            usage: Some(serde_json::json!({"prompt_tokens": 10, "completion_tokens": 5, "prompt_tokens_details": {"cached_tokens": 3}})),
        }),
    ];
    let datas: Vec<String> = stream_openai_events(
        futures::stream::iter(events),
        "chatcmpl-1",
        "deepseek-v4-flash",
    )
    .collect::<Vec<_>>()
    .await
    .into_iter()
    .map(|e| e.unwrap().data().to_string())
    .collect();
    // Delta → [usage, finish, [DONE]]
    assert!(datas[0].contains("\"content\":\"hi\""), "first={}", datas[0]);
    assert!(datas[1].contains("\"usage\""), "usage chunk={}", datas[1]);
    assert!(datas[1].contains("\"choices\":[]"), "empty choices={}", datas[1]);
    assert!(datas[2].contains("\"finish_reason\":\"stop\""), "finish={}", datas[2]);
    assert_eq!(datas[3], "[DONE]");
}

#[tokio::test]
async fn stream_assigns_tool_call_indices_by_call_id() {
    let events = vec![
        Ok::<ProvEvent, ProviderError>(ProvEvent::ToolCall {
            id: "call_a".into(), name: "read".into(), arguments: serde_json::json!({"p": 1}),
        }),
        Ok(ProvEvent::ToolCall {
            id: "call_b".into(), name: "write".into(), arguments: serde_json::json!({"p": 2}),
        }),
        Ok(ProvEvent::Finish { stop_reason: "tool_calls".into(), usage: None }),
    ];
    let datas: Vec<String> = stream_openai_events(futures::stream::iter(events), "chatcmpl-1", "m")
        .collect::<Vec<_>>().await.into_iter().map(|e| e.unwrap().data().to_string()).collect();
    assert!(datas[0].contains("\"index\":0") && datas[0].contains("call_a"), "first={}", datas[0]);
    assert!(datas[1].contains("\"index\":1") && datas[1].contains("call_b"), "second={}", datas[1]);
    assert!(datas[2].contains("\"finish_reason\":\"tool_calls\""));
    assert_eq!(datas[3], "[DONE]");
}
```
(`futures::executor::block_on_stream` 在 dev 场景可用;server.rs 已依赖 futures。)

- [ ] **Step 3: 运行确认失败**

Run: `cargo test -p rc-gateway stream_ 2>&1 | tail -12`
Expected: FAIL(`stream_openai_events` 未定义)。

- [ ] **Step 4: 实现 —— 抽出 `stream_openai_events` + 流式分支改造**

(a) 在 `now_ts()` 附近新增辅助函数与 usage chunk builder:
```rust
/// 把 rc-pro 事件流翻译成 OpenAI 流式 SSE 事件。Finish → usage chunk + finish chunk
/// + `data: [DONE]`;工具调用按 call id 递增 index。抽取为纯函数便于单测。
fn stream_openai_events(
    stream: impl Stream<Item = Result<ProvEvent, ProviderError>>,
    id: &str,
    model: &str,
) -> impl Stream<Item = Result<Event, Infallible>> {
    let id = id.to_string();
    let model = model.to_string();
    let mut tool_index: HashMap<String, usize> = HashMap::new();
    let mut next_tool_index = 0usize;
    stream.flat_map(move |event| {
        let mut events: Vec<Event> = Vec::new();
        match event {
            Ok(ProvEvent::Delta { text }) => {
                events.push(openai_chunk(&id, &model, json!({"content": text}), None));
            }
            Ok(ProvEvent::Thinking { text }) => {
                events.push(openai_chunk(&id, &model, json!({"reasoning_content": text}), None));
            }
            Ok(ProvEvent::ToolCall { id: call_id, name, arguments }) => {
                let idx = *tool_index.entry(call_id.clone()).or_insert_with(|| {
                    let i = next_tool_index;
                    next_tool_index += 1;
                    i
                });
                events.push(openai_chunk(
                    &id,
                    &model,
                    json!({"tool_calls": [{
                        "index": idx, "id": call_id, "type": "function",
                        "function": {"name": name, "arguments": arguments.to_string()}
                    }]}),
                    None,
                ));
            }
            Ok(ProvEvent::ToolCallEnd { .. }) => {}
            Ok(ProvEvent::Finish { stop_reason, usage }) => {
                if let Some(u) = usage {
                    events.push(openai_usage_chunk(&id, &model, u));
                }
                events.push(openai_chunk(&id, &model, json!({}), Some(&stop_reason)));
                events.push(Event::default().data("[DONE]"));
            }
            Ok(ProvEvent::Error { message }) => {
                events.push(openai_error_chunk(&id, &model, &message));
            }
            Err(e) => {
                events.push(openai_error_chunk(&id, &model, &e.to_string()));
            }
        }
        futures::stream::iter(events.into_iter().map(Ok::<Event, Infallible>))
    })
}

fn openai_usage_chunk(id: &str, model: &str, usage: Value) -> Event {
    let data = json!({
        "id": id,
        "object": "chat.completion.chunk",
        "created": now_ts(),
        "model": model,
        "choices": [],
        "usage": usage,
    });
    Event::default().event("message").data(data.to_string())
}
```

(b) 在 `chat_completions` 的 `if body.stream { ... }` 分支内,把整段 `.map(...)` 换成调用辅助函数:
```rust
    if body.stream {
        let id = format!("chatcmpl-{}", now_ts());
        let stream = stream_openai_events(stream, &id, &model);
        return Sse::new(stream)
            .keep_alive(KeepAlive::default())
            .into_response();
    }
```
(删除旧的 `.map(move |event| ...)` 整块。)

- [ ] **Step 5: 运行确认通过**

Run: `cargo test -p rc-gateway 2>&1 | tail -10`
Expected: PASS(含新 stream 测试 + 既有 health/switch 测试)。

- [ ] **Step 6: Commit**

```bash
git add crates/rc-gateway/src/server.rs
git commit -m "feat(rc-gateway): 流式补齐 — usage 先于 finish + [DONE] + 工具 index 递增"
```

---

## Task 4: gateway —— 按 model 选 profile + `/v1/models` + `/skills`

**Files:**
- Modify: `crates/rc-gateway/src/server.rs`
- Modify: `crates/rc-gateway/Cargo.toml`
- Modify: `crates/rc-cli/src/main.rs`
- Test: `crates/rc-gateway/src/server.rs`

**Interfaces:**
- Consumes: `Registry`(rc_profile)、`SkillStore::new(dir).discover()`(rc-skill)。
- Produces: `chat_completions` 按 `model` 精确匹配 `profile.model`/`profile.id` 再回退 active;`GET /v1/models` 返回池;`GET /skills` 返回 skill 清单;`GatewayConfig.skills_dir` + `rc_gateway::default_skills_dir()`。

- [ ] **Step 1: 加依赖 + import**

`crates/rc-gateway/Cargo.toml` 的 `[dependencies]` 追加:
```toml
rc-skill = { workspace = true }
dirs = { workspace = true }
```

server.rs 顶部 import 区,`use rc_profile::model::{Profile, Registry};` 已存在,追加 `use rc_skill::SkillStore;`。

- [ ] **Step 2: 写失败测试**

在 server.rs test 模块中新增:
```rust
#[tokio::test]
async fn models_lists_profiles_from_registry() {
    let app = test_app();
    let resp = app.oneshot(
        Request::builder().uri("/v1/models").body(Body::empty()).unwrap(),
    ).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = to_bytes(resp.into_body(), 65536).await.unwrap();
    let value: Value = serde_json::from_slice(&body).unwrap();
    let ids: Vec<String> = value["data"].as_array().unwrap_or(&vec![])
        .iter().filter_map(|m| m["id"].as_str().map(str::to_string)).collect();
    // test_app 的 registry 带一个 OpenAiCompat profile(见 Step 4(f)),
    // Mock 默认 profile 会被过滤,故只断言我们加的那个。
    assert!(ids.contains(&"deepseek-v4-flash".to_string()), "ids={ids:?}");
}

#[tokio::test]
async fn skills_lists_skill_files() {
    let app = test_app();
    let resp = app.oneshot(
        Request::builder().uri("/skills").body(Body::empty()).unwrap(),
    ).await.unwrap();
    let body = to_bytes(resp.into_body(), 65536).await.unwrap();
    let value: Value = serde_json::from_slice(&body).unwrap();
    let names: Vec<String> = value["skills"].as_array().unwrap_or(&vec![])
        .iter().filter_map(|s| s["name"].as_str().map(str::to_string)).collect();
    assert!(names.contains(&"probe-skill".to_string()), "names={names:?}");
}
```

- [ ] **Step 3: 运行确认失败**

Run: `cargo test -p rc-gateway models_ 2>&1 | tail -8`
Expected: FAIL(路由不存在,404)。

- [ ] **Step 4: 实现 —— 结构 + 状态 + 路由 + handler**

(a) `GatewayConfig` 与 `GatewayState` 加 `skills_dir`:
```rust
pub struct GatewayConfig {
    pub addr: std::net::SocketAddr,
    pub registry_path: PathBuf,
    pub skills_dir: PathBuf,
}

/// `~/.raincode/skills`;rc-cli 构造 GatewayConfig 时复用同一默认。
pub fn default_skills_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".raincode")
        .join("skills")
}

impl Default for GatewayConfig {
    fn default() -> Self {
        Self {
            addr: "127.0.0.1:4040".parse().expect("valid local addr"),
            registry_path: rc_profile::model::default_registry_path(),
            skills_dir: default_skills_dir(),
        }
    }
}

pub struct GatewayState {
    registry_path: PathBuf,
    skills_dir: PathBuf,
    registry: RwLock<Registry>,
}
```

(b) `GatewayState` 新增方法(在 `active_profile` 附近):
```rust
    /// 按 `model` 精确匹配 profile.model 或 profile.id;未命中返回 None(调用方回退 active)。
    fn profile_for_model(&self, model: &str) -> Option<Profile> {
        let registry = self.registry.read().ok()?;
        registry
            .profiles
            .iter()
            .find(|p| p.model == model || p.id == model)
            .cloned()
    }
```

(c) `serve()`:构造 state 传入 `skills_dir`,注册新路由:
```rust
    let state = Arc::new(GatewayState {
        registry_path: config.registry_path,
        skills_dir: config.skills_dir,
        registry: RwLock::new(registry),
    });
    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/chat/completions", post(chat_completions))
        .route("/v1/models", get(models))
        .route("/skills", get(skills))
        .route("/v1/messages", post(messages))
        .route("/v1/embeddings", post(embeddings))
        .route("/switch", post(switch_profile))
        .with_state(state);
```

(d) `chat_completions` 开头,把活跃 profile 解析改为按 model 选 profile(替换原有 `let profile = match state.active_profile() ...` 与 `let model = body.model.clone() ...` 两行):
```rust
    let model = body.model.clone();
    let profile = {
        let picked = match model.as_deref() {
            Some(m) => state.profile_for_model(m).or_else(|| state.active_profile().ok()),
            None => state.active_profile().ok(),
        };
        match picked {
            Some(p) => p,
            None => {
                return gateway_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "no profile for model".into(),
                )
            }
        }
    };
    let model = model.unwrap_or_else(|| profile.model.clone());
```

(e) 新增两个 handler(放在 `health` 之后):
```rust
async fn models(State(state): State<Arc<GatewayState>>) -> Response {
    let registry = match state.registry.read() {
        Ok(r) => r,
        Err(_) => return gateway_error(StatusCode::INTERNAL_SERVER_ERROR, "lock poisoned".into()),
    };
    let data: Vec<Value> = registry
        .profiles
        .iter()
        .filter(|p| p.kind != rc_profile::model::ProfileKind::Mock)
        .map(|p| json!({"id": p.model, "name": p.name, "object": "model", "created": 0}))
        .collect();
    Json(json!({"object": "list", "data": data})).into_response()
}

async fn skills(State(state): State<Arc<GatewayState>>) -> Response {
    let store = SkillStore::new(&state.skills_dir);
    let items: Vec<Value> = store
        .discover()
        .into_iter()
        .map(|s| json!({
            "name": s.name,
            "category": s.category,
            "description": s.description,
            "tags": s.tags,
            "body": s.body,
        }))
        .collect();
    Json(json!({"skills": items})).into_response()
}
```

(f) `test_app()` 构造带临时 skills_dir + 预写 probe skill + 一个非 Mock profile:
```rust
    fn test_app() -> Router {
        let dir = tempfile::tempdir().unwrap();
        let registry_path = dir.path().join("profiles.toml");
        let skills_dir = dir.path().join("skills");
        std::fs::create_dir_all(&skills_dir).unwrap();
        std::fs::write(
            skills_dir.join("SKILL.md"),
            "---\nname: probe-skill\ncategory: probe\n---\nbody text\n",
        )
        .unwrap();
        let mut registry = Registry::default();
        registry.ensure_default();
        // Mock 默认 profile 会被 /v1/models 过滤;加一个 OpenAiCompat 供断言。
        let mut p = registry.profiles[0].clone();
        p.id = "deepseek-v4-flash".into();
        p.name = "DeepSeek v4 Flash".into();
        p.model = "deepseek-v4-flash".into();
        p.kind = rc_profile::model::ProfileKind::OpenAiCompat;
        p.base_url = "https://example.com/v1".into();
        registry.profiles.push(p);
        registry.save(&registry_path).unwrap();
        // 注意:不 drop(dir)——/skills 测试要读临时目录下的 SKILL.md,dir 活到函数末尾即可。
        let state = Arc::new(GatewayState {
            registry_path,
            skills_dir,
            registry: RwLock::new(registry),
        });
        Router::new()
            .route("/health", get(health))
            .route("/v1/models", get(models))
            .route("/skills", get(skills))
            .route("/switch", post(switch_profile))
            .with_state(state)
    }
```

- [ ] **Step 5: 更新 rc-cli 的 GatewayConfig 构造**

在 `crates/rc-cli/src/main.rs` 的 `Command::Proxy` 分支:
```rust
        Some(Command::Proxy { port }) => {
            let addr = format!("127.0.0.1:{port}");
            let gateway_config = GatewayConfig {
                addr: addr.parse().context("invalid gateway address")?,
                registry_path: registry_path(),
                skills_dir: rc_gateway::default_skills_dir(),
            };
            serve_gateway(gateway_config).await?;
            Ok(())
        }
```

- [ ] **Step 6: 运行全部测试确认**

Run: `cargo test -p rc-gateway 2>&1 | tail -8`
Expected: PASS(含 models/skills/profile 测试)。

- [ ] **Step 7: 手工冒烟**

```bash
cargo build -p rc-gateway 2>&1 | tail -2
cargo run -p rc-cli -- proxy --port 8799 &
sleep 4
echo "--- /v1/models ---"; curl -s http://127.0.0.1:8799/v1/models | head -c 400
echo ""; echo "--- /skills ---"; curl -s http://127.0.0.1:8799/skills | head -c 300
kill %1
```
Expected:`/v1/models` 返回 `data` 数组含你 ~/.raincode/profiles.toml 里的模型;`/skills` 返回 skills 清单(至少含 seed 技能)。

- [ ] **Step 8: Commit**

```bash
git add crates/rc-gateway crates/rc-cli/src/main.rs
git commit -m "feat(rc-gateway): 按 model 选 profile + /v1/models + /skills 端点"
```

---

## Task 5: TS 插件脚手架

**Files:**
- Create: `G:/claude codex_workspace/dsh-plugins-raincode/package.json`
- Create: `G:/claude codex_workspace/dsh-plugins-raincode/tsconfig.json`
- Create: `G:/claude codex_workspace/dsh-plugins-raincode/vitest.config.ts`
- Create: `G:/claude codex_workspace/dsh-plugins-raincode/.gitignore`
- Create: `G:/claude codex_workspace/dsh-plugins-raincode/LICENSE`

**Interfaces:**
- Produces: 可 `npm install`、`npm test`、`npm run build` 的独立包骨架。

- [ ] **Step 1: 建目录 + package.json**

```bash
mkdir -p "G:/claude codex_workspace/dsh-plugins-raincode/src"
cd "G:/claude codex_workspace/dsh-plugins-raincode"
git init
```

写 `package.json`:
```json
{
  "name": "dsh-plugins-raincode",
  "version": "0.1.0",
  "description": "Use raincode's model layer (cheap model pool, prompt caching, retry) and skill library inside DeepSeek Harness (dsh)",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "exports": {
    ".": {
      "types": "./lib/index.d.ts",
      "default": "./lib/index.js"
    },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "files": ["lib", "README.md", "LICENSE"],
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/rainforest888/dsh-plugins-raincode.git"
  },
  "keywords": ["dsh", "dsh-plugin", "raincode", "deepseek", "llm", "llm-gateway", "model-pool", "prompt-caching", "multi-model"],
  "publishConfig": { "access": "public" },
  "peerDependencies": {
    "@deepseek-ai/dsh-anonymous-user-id": "0.0.1-rc.5",
    "@deepseek-ai/dsh-commands": "0.0.1-rc.1",
    "@deepseek-ai/dsh-credentials": "0.0.1-rc.1",
    "@deepseek-ai/dsh-invariants": "0.0.1-rc.1",
    "@deepseek-ai/dsh-launch-environment": "0.0.1-rc.3",
    "@deepseek-ai/dsh-llm": "0.0.1-rc.1",
    "@deepseek-ai/dsh-settings": "0.0.1-rc.1",
    "@deepseek-ai/dsh-timeout": "0.0.1-rc.1",
    "@deepseek-ai/cordis": "4.0.1"
  },
  "dependencies": {
    "@deepseek-ai/schemastery": "3.18.1",
    "eventsource-parser": "^3.1.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.1.0"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: tsconfig.json + vitest.config.ts + .gitignore + LICENSE**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "lib",
    "rootDir": "src",
    "declaration": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['src/**/*.spec.ts'] },
})
```

`.gitignore`:
```
node_modules/
lib/
*.tsbuildinfo
```

`LICENSE`:复制 `G:/claude codex_workspace/raincode-iter/LICENSE`(MIT)内容。

- [ ] **Step 3: 安装依赖**

Run:`cd "G:/claude codex_workspace/dsh-plugins-raincode" && npm install`
Expected:安装成功(peer 以 `--legacy-peer-deps` 兼容,若 npm 报 peer 冲突:`npm install --legacy-peer-deps`)。

- [ ] **Step 4: 空测试占位跑通**

写 `src/placeholder.spec.ts`:
```ts
import { describe, it, expect } from 'vitest'

describe('scaffold', () => {
  it('runs', () => { expect(1 + 1).toBe(2) })
})
```
Run: `npm test`
Expected: PASS 1。删掉该文件(临时占位)。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold dsh-plugins-raincode package"
```

---

## Task 6: serialize.ts + 测试

**Files:**
- Create: `G:/claude codex_workspace/dsh-plugins-raincode/src/serialize.ts`
- Create: `G:/claude codex_workspace/dsh-plugins-raincode/src/serialize.spec.ts`

**Interfaces:**
- Consumes: `GenerateOptions`、`Message`、`ToolSchema`(`@deepseek-ai/dsh-llm`)。
- Produces: `serializeRequest(options): Record<string, unknown>` —— OpenAI 请求体(`model`/`messages`/`tools`/`stream:true`/`temperature`/`max_tokens`/`stop`/`reasoning_effort`)。

- [ ] **Step 1: 写失败测试**

`src/serialize.spec.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { serializeRequest } from './serialize.js'
import type { GenerateOptions, Message, ContentBlock } from '@deepseek-ai/dsh-llm'

function msg(role: 'user' | 'assistant', blocks: ContentBlock[]): Message {
  return {
    id: `m-${Math.random()}`,
    role,
    content: blocks,
    source: role === 'assistant' ? { kind: 'model', provider: 'raincode', model: 'm' } : { kind: 'user' },
  }
}

describe('serializeRequest', () => {
  const options: GenerateOptions = {
    provider: 'raincode',
    model: 'deepseek-v4-flash',
    system: 'You are a coding agent.',
    messages: [
      msg('user', [{ type: 'text', text: 'hello' }]),
      msg('assistant', [
        { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a.ts"}' },
      ]),
      msg('user', [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'ok' }] }]),
    ],
    tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
    stop: ['END'],
    reasoningEffort: 'high',
  }

  it('builds a deepseek-compatible chat body', () => {
    const body = serializeRequest(options)
    expect(body['model']).toBe('deepseek-v4-flash')
    expect(body['stream']).toBe(true)
    expect(body['stop']).toEqual(['END'])
    expect(body['reasoning_effort']).toBe('high')
    const messages = body['messages'] as Record<string, unknown>[]
    expect(messages[0]).toEqual({ role: 'system', content: 'You are a coding agent.' })
    expect(messages[1]).toEqual({ role: 'user', content: 'hello' })
    expect(messages[2]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a.ts"}' } }] })
    expect(messages[3]).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: 'ok' })
    const tools = body['tools'] as Record<string, unknown>[]
    expect(tools[0]).toMatchObject({ type: 'function', function: { name: 'read' } })
  })

  it('omits reasoning_effort when off', () => {
    const body = serializeRequest({ ...options, reasoningEffort: 'off' })
    expect(body['reasoning_effort']).toBeUndefined()
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL(`Cannot find module './serialize.js'`)。

- [ ] **Step 3: 实现**

`src/serialize.ts`:
```ts
import type { GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'

function textOf(blocks: readonly { type: string; text?: string }[]): string {
  return blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')
}

export function serializeRequest(options: GenerateOptions): Record<string, unknown> {
  const messages = options.messages.map(serializeMessage)
  if (options.system !== undefined) {
    messages.unshift({ role: 'system', content: options.system })
  }
  const body: Record<string, unknown> = {
    model: options.model,
    messages,
    stream: true,
  }
  if (options.tools !== undefined && options.tools.length > 0) {
    body['tools'] = options.tools.map(serializeTool)
  }
  if (options.temperature !== undefined) body['temperature'] = options.temperature
  if (options.maxTokens !== undefined) body['max_tokens'] = options.maxTokens
  if (options.stop !== undefined && options.stop.length > 0) body['stop'] = options.stop
  // "off" → 显式关 thinking,不发射 reasoning_effort。
  if (options.reasoningEffort !== undefined && options.reasoningEffort !== 'off') {
    body['reasoning_effort'] = options.reasoningEffort
  }
  return body
}

function serializeTool(tool: ToolSchema): Record<string, unknown> {
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }
}

function serializeMessage(message: Message): Record<string, unknown> {
  if (message.role === 'assistant') {
    const toolCalls = message.content
      .filter((b) => b.type === 'tool-call')
      .map((b) => {
        const tc = b as { id: string; name: string; arguments: string }
        return { id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } }
      })
    const out: Record<string, unknown> = { role: 'assistant', content: textOf(message.content) }
    if (toolCalls.length > 0) out['tool_calls'] = toolCalls
    return out
  }
  if (message.role === 'user') {
    const toolResults = message.content.filter((b) => b.type === 'tool-result')
    if (toolResults.length > 0) {
      const tr = toolResults[0] as { toolCallId: string; content: readonly { type: string; text?: string }[]; isError?: boolean }
      return { role: 'tool', tool_call_id: tr.toolCallId, content: textOf(tr.content) }
    }
    return { role: 'user', content: textOf(message.content) }
  }
  return { role: 'system', content: textOf(message.content) }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/serialize.ts src/serialize.spec.ts
git commit -m "feat: serialize GenerateOptions -> OpenAI chat body"
```

---

## Task 7: translate.ts + 测试

**Files:**
- Create: `G:/claude codex_workspace/dsh-plugins-raincode/src/translate.ts`
- Create: `G:/claude codex_workspace/dsh-plugins-raincode/src/translate.spec.ts`

**Interfaces:**
- Consumes: OpenAI 流式 chunk(`choices[].delta.content`/`reasoning_content`/`tool_calls`、`choices[].finish_reason`、顶层 `usage`)。
- Produces: `createTranslateState()` 与 `translateChunk(chunk, state): StreamChunk[]`。契约:usage 先于 finish;text/reasoning/tool-call block-start→delta→block-end;finish 后 `state.finished = true`。

- [ ] **Step 1: 写失败测试**

`src/translate.spec.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { createTranslateState, translateChunk } from './translate.js'

describe('translateChunk', () => {
  it('maps deltas, reasoning, tool calls, usage, finish in order', () => {
    const state = createTranslateState()
    const chunks: Record<string, unknown>[] = [
      { choices: [{ delta: { content: 'hi ' }, index: 0 }] },
      { choices: [{ delta: { reasoning_content: 'thinking...' }, index: 0 }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"p":1}' } }] }, index: 0 }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } },
    ]
    const all = chunks.flatMap((c) => translateChunk(c, state))
    expect(all.some((c) => c.type === 'text-delta' && (c as { text: string }).text === 'hi ')).toBe(true)
    expect(all.some((c) => c.type === 'reasoning-delta' && (c as { text: string }).text === 'thinking...')).toBe(true)
    const toolDelta = all.find((c) => c.type === 'tool-call-delta')
    expect(toolDelta).toMatchObject({ id: 'call_1', name: 'read', argumentsDelta: '{"p":1}' })
    const blockEnd = all.find((c) => c.type === 'block-end')
    expect(blockEnd).toMatchObject({ block: { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"p":1}' } })
    const usageIdx = all.findIndex((c) => c.type === 'usage')
    const finishIdx = all.findIndex((c) => c.type === 'finish')
    expect(usageIdx).toBeGreaterThan(-1)
    expect(finishIdx).toBeGreaterThan(usageIdx)
    expect(all.find((c) => c.type === 'usage')).toMatchObject({ usage: { inputTokens: 6, outputTokens: 2, cacheReadTokens: 4 } })
    expect(all.find((c) => c.type === 'finish')).toMatchObject({ reason: { kind: 'tool-calls' } })
    expect(state.finished).toBe(true)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL(`Cannot find module './translate.js'`)。

- [ ] **Step 3: 实现**

`src/translate.ts`:
```ts
import type { FinishReason, StreamChunk } from '@deepseek-ai/dsh-llm'

export interface TranslateState {
  openIndex: number
  openType: 'text' | 'reasoning' | 'tool-call' | null
  openText: string
  openReasoning: string
  openToolId: string
  openToolName: string
  openToolArgs: string
  finished: boolean
  nextIndex: number
}

export function createTranslateState(): TranslateState {
  return { openIndex: -1, openType: null, openText: '', openReasoning: '', openToolId: '', openToolName: '', openToolArgs: '', finished: false, nextIndex: 0 }
}

function closeBlock(state: TranslateState, out: StreamChunk[]): void {
  if (state.openType === null) return
  const index = state.openIndex
  if (state.openType === 'text') {
    out.push({ type: 'block-end', index, block: { type: 'text', text: state.openText } })
  } else if (state.openType === 'reasoning') {
    out.push({ type: 'block-end', index, block: { type: 'reasoning', text: state.openReasoning } })
  } else {
    out.push({ type: 'block-end', index, block: { type: 'tool-call', id: state.openToolId, name: state.openToolName, arguments: state.openToolArgs } })
  }
  state.openType = null
  state.openIndex = -1
}

function beginBlock(state: TranslateState, out: StreamChunk[], type: 'text' | 'reasoning' | 'tool-call'): number {
  if (state.openType !== null && state.openType !== type) closeBlock(state, out)
  if (state.openType === type) return state.openIndex
  const index = state.nextIndex++
  state.openIndex = index
  state.openType = type
  state.openText = ''
  state.openReasoning = ''
  state.openToolId = ''
  state.openToolName = ''
  state.openToolArgs = ''
  out.push({ type: 'block-start', index, blockType: type })
  return index
}

export function translateChunk(chunk: Record<string, unknown>, state: TranslateState): StreamChunk[] {
  const out: StreamChunk[] = []
  const choices = Array.isArray(chunk['choices']) ? (chunk['choices'] as Array<Record<string, unknown>>) : []
  for (const choice of choices) {
    const delta = (choice['delta'] ?? {}) as Record<string, unknown>
    if (typeof delta['content'] === 'string' && delta['content'] !== '') {
      const index = beginBlock(state, out, 'text')
      state.openText += delta['content']
      out.push({ type: 'text-delta', index, text: delta['content'] })
    }
    if (typeof delta['reasoning_content'] === 'string' && delta['reasoning_content'] !== '') {
      const index = beginBlock(state, out, 'reasoning')
      state.openReasoning += delta['reasoning_content']
      out.push({ type: 'reasoning-delta', index, text: delta['reasoning_content'] })
    }
    const toolCalls = Array.isArray(delta['tool_calls']) ? (delta['tool_calls'] as Array<Record<string, unknown>>) : []
    for (const tc of toolCalls) {
      const fn = (tc['function'] ?? {}) as Record<string, unknown>
      const index = beginBlock(state, out, 'tool-call')
      if (typeof tc['id'] === 'string' && tc['id'] !== '') state.openToolId = tc['id']
      if (typeof fn['name'] === 'string' && fn['name'] !== '') state.openToolName = fn['name']
      const argsDelta = typeof fn['arguments'] === 'string' ? fn['arguments'] : ''
      if (argsDelta !== '') state.openToolArgs += argsDelta
      out.push({ type: 'tool-call-delta', index, id: state.openToolId, name: state.openToolName, argumentsDelta: argsDelta })
    }
    const finishReason = choice['finish_reason']
    if (typeof finishReason === 'string' && finishReason !== '') {
      closeBlock(state, out)
      state.finished = true
      out.push({ type: 'finish', reason: mapFinishReason(finishReason) })
    }
  }
  if (chunk['usage'] !== undefined) {
    out.push({ type: 'usage', usage: toTokenUsage(chunk['usage'] as Record<string, unknown>) })
  }
  return out
}

function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    default: return { kind: 'error', failure: { message: `provider finish_reason: ${reason}`, code: 'UNKNOWN_FINISH' } }
  }
}

function toTokenUsage(usage: Record<string, unknown>): { inputTokens: number; outputTokens: number; cacheReadTokens?: number } {
  const prompt = typeof usage['prompt_tokens'] === 'number' ? usage['prompt_tokens'] : 0
  const completion = typeof usage['completion_tokens'] === 'number' ? usage['completion_tokens'] : 0
  const details = (usage['prompt_tokens_details'] ?? {}) as Record<string, unknown>
  const cached = typeof details['cached_tokens'] === 'number'
    ? details['cached_tokens'] as number
    : typeof usage['prompt_cache_hit_tokens'] === 'number'
      ? usage['prompt_cache_hit_tokens'] as number
      : 0
  const out: { inputTokens: number; outputTokens: number; cacheReadTokens?: number } = {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: completion,
  }
  if (cached > 0) out['cacheReadTokens'] = cached
  return out
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test`
Expected: PASS(serialize + translate)。

- [ ] **Step 5: Commit**

```bash
git add src/translate.ts src/translate.spec.ts
git commit -m "feat: translate OpenAI chunks -> dsh StreamChunks"
```

---

## Task 8: adapter.ts(stream / listModels / resolveModel)+ 测试

**Files:**
- Create: `G:/claude codex_workspace/dsh-plugins-raincode/src/adapter.ts`
- Create: `G:/claude codex_workspace/dsh-plugins-raincode/src/adapter.spec.ts`

**Interfaces:**
- Consumes: Task 6 `serializeRequest`、Task 7 `translateChunk`/`createTranslateState`、Task 5 的 `src/sse.ts`(本任务实现)。
- Produces: `RaincodeAdapter extends LlmAdapter`;`RaincodeAdapterOptions { options: () => RaincodeConnectionOptions; resolveApiKey: () => Promise<string> }`;`RaincodeConnectionOptions { baseURL; apiKey; models: RaincodeModel[]; streamIdleTimeoutMs }`。

- [ ] **Step 1: 写失败测试**

`src/adapter.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { RaincodeAdapter, type RaincodeConnectionOptions } from './adapter.js'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

let server: Server
let port = 0
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.url === '/v1/chat/completions') {
        const parsed = JSON.parse(body) as { model?: string; stop?: string[] }
        const chunks = [
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'pong' }, index: 0 }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } })}\n\n`,
          'data: [DONE]\n\n',
        ]
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(chunks.join(''))
        return
      }
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-v4-flash', name: 'Flash' }] }))
        return
      }
      res.writeHead(404).end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const addr = server.address()
  if (addr && typeof addr === 'object') port = addr.port
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

function conn(): RaincodeConnectionOptions {
  return { baseURL: `http://127.0.0.1:${port}`, models: [{ id: 'deepseek-v4-flash', name: 'Flash' }], streamIdleTimeoutMs: 5000 }
}

function makeOptions(): GenerateOptions {
  return {
    provider: 'raincode', model: 'deepseek-v4-flash',
    messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }],
  }
}

describe('RaincodeAdapter', () => {
  it('streams a chat call into StreamChunks', async () => {
    const adapter = new RaincodeAdapter({ options: conn, resolveApiKey: async () => 'dummy' })
    const out: unknown[] = []
    for await (const chunk of adapter.stream(makeOptions())) out.push(chunk)
    expect(out.some((c) => c.type === 'text-delta' && (c as { text: string }).text === 'pong')).toBe(true)
    const usage = out.find((c) => c.type === 'usage')
    expect(usage).toMatchObject({ usage: { inputTokens: 5, outputTokens: 1 } })
    expect(out.find((c) => c.type === 'finish')).toMatchObject({ reason: { kind: 'stop' } })
  })

  it('listModels advertises the pool', async () => {
    const adapter = new RaincodeAdapter({ options: conn, resolveApiKey: async () => 'dummy' })
    const models = await adapter.listModels('raincode')
    expect(models.map((m) => m.id)).toContain('deepseek-v4-flash')
  })

  it('maps 401 to an AUTH LlmError', async () => {
    const badServer = createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'nope' } }))
    })
    await new Promise<void>((r) => badServer.listen(0, '127.0.0.1', () => r()))
    const a = badServer.address()
    const badPort = a && typeof a === 'object' ? a.port : 0
    try {
      const adapter = new RaincodeAdapter({
        options: () => ({ ...conn(), baseURL: `http://127.0.0.1:${badPort}` }),
        resolveApiKey: async () => 'dummy',
      })
      const acc: unknown[] = []
      for await (const c of adapter.stream(makeOptions())) acc.push(c)
      expect(acc[0]).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH' } } })
    } finally {
      await new Promise<void>((r) => badServer.close(() => r()))
    }
  })
})
```
注:非 2xx 我们让 `stream()` 抛 `LlmError`;`LlmRuntime.stream()` 会把 throw 归一化成 error finish,但裸 adapter 测试里是抛异常。把第 3 个用例改为断言抛 `LlmError`(code AUTH):
```ts
  it('maps 401 to an AUTH LlmError', async () => {
    // ... 同上起 badServer ...
    const adapter = new RaincodeAdapter({ options: () => ({ ...conn(), baseURL: `http://127.0.0.1:${badPort}` }), resolveApiKey: async () => 'dummy' })
    await expect(async () => {
      for await (const _c of adapter.stream(makeOptions())) { /* noop */ }
    }).rejects.toThrow('AUTH')
  })
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL(`Cannot find module './adapter.js'`)。

- [ ] **Step 3: 实现 `src/sse.ts`**

```ts
import { createParser } from 'eventsource-parser'

/**
 * 把 fetch Response 的 SSE 流解析为逐条 `data:` 内容(跳过 `[DONE]`)。
 * 事件回调在 parser 内部同步执行,故 queue+notify 模式安全。
 */
export async function* readSseData(resp: Response): AsyncGenerator<string> {
  if (resp.body === null) throw new Error('response has no body')
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  const queue: string[] = []
  let done = false
  let notify: (() => void) | null = null

  const pump = async (): Promise<void> => {
    const parser = createParser((event) => {
      if (event.data !== '[DONE]') queue.push(event.data)
      if (notify) { notify(); notify = null }
    })
    for (;;) {
      const { value, done: d } = await reader.read()
      if (d) break
      parser.feed(decoder.decode(value, { stream: true }))
    }
  }

  void pump().then(
    () => { done = true; if (notify) { notify(); notify = null } },
    () => { done = true; if (notify) { notify(); notify = null } },
  )

  try {
    while (!done) {
      if (queue.length > 0) {
        yield queue.shift() as string
      } else {
        await new Promise<void>((r) => {
          notify = r
          if (queue.length > 0 || done) r()
        })
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}
```

- [ ] **Step 4: 实现 `src/adapter.ts`**

```ts
import { attributionHeaders, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { serializeRequest } from './serialize.js'
import { readSseData } from './sse.js'
import { createTranslateState, translateChunk } from './translate.js'

export interface RaincodeModel {
  id: string
  name?: string
  description?: string
}

export interface RaincodeConnectionOptions {
  baseURL: string
  models: RaincodeModel[]
  streamIdleTimeoutMs: number
}

export interface RaincodeAdapterOptions {
  options: () => RaincodeConnectionOptions
  resolveApiKey: () => Promise<string>
}

export class RaincodeAdapter extends LlmAdapter {
  constructor(private readonly opts: RaincodeAdapterOptions) {
    super()
  }

  override async listModels(_provider: string): Promise<LlmModelInfo[]> {
    const models = this.opts.options().models
    if (models.length === 0) return []
    return models.map((m) => ({
      provider: 'raincode',
      id: m.id,
      name: m.name ?? m.id,
      ...(m.description !== undefined ? { description: m.description } : {}),
      inputModalities: ['text'] as const,
    }))
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const found = this.opts.options().models.find((m) => m.id === model)
    return {
      provider,
      id: model,
      name: found?.name ?? model,
      ...(found?.description !== undefined ? { description: found.description } : {}),
    }
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const conn = this.opts.options()
    const apiKey = await this.opts.resolveApiKey()
    const body = serializeRequest(options)
    const url = `${conn.baseURL.replace(/\/+$/, '')}/v1/chat/completions`
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
          ...attributionHeaders(),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        throw mapHttpError(resp.status, text)
      }
      const state = createTranslateState()
      for await (const data of readSseData(resp)) {
        let chunk: Record<string, unknown>
        try {
          chunk = JSON.parse(data) as Record<string, unknown>
        } catch {
          continue
        }
        for (const sc of translateChunk(chunk, state)) yield sc
        if (state.finished) return
      }
      if (!state.finished) {
        throw new LlmError('raincode gateway stream ended without a finish chunk', 'STREAM_CLOSED')
      }
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
    }
  }
}

function mapHttpError(status: number, body: string): LlmError {
  const message = `raincode gateway ${status}: ${body.slice(0, 300)}`
  switch (status) {
    case 401:
    case 403:
      return new LlmError(message, 'AUTH')
    case 429:
      return new LlmError(message, 'RATE_LIMIT')
    case 400:
      return /context/i.test(body)
        ? new LlmError(message, 'CONTEXT_WINDOW_EXCEEDED')
        : new LlmError(message, 'INVALID_REQUEST')
    default:
      return new LlmError(message, status >= 500 ? 'SERVER' : `HTTP_${status}`)
  }
}
```

- [ ] **Step 5: 运行确认通过**

Run: `npm test`
Expected: PASS(adapter 3 用例 + serialize + translate)。

- [ ] **Step 6: typecheck**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 7: Commit**

```bash
git add src/sse.ts src/adapter.ts src/adapter.spec.ts
git commit -m "feat: RaincodeAdapter streams via raincode gateway"
```

---

## Task 9: index.ts(插件入口)+ commands.ts(`/skills`)+ 测试

**Files:**
- Create: `G:/claude codex_workspace/dsh-plugins-raincode/src/commands.ts`
- Create: `G:/claude codex_workspace/dsh-plugins-raincode/src/commands.spec.ts`
- Create: `G:/claude codex_workspace/dsh-plugins-raincode/src/index.ts`

**Interfaces:**
- Consumes: Task 8 `RaincodeAdapter`/`RaincodeConnectionOptions`;`@deepseek-ai/dsh-settings` 的 `installSettingsSection`/`settingsNamespace`;`@deepseek-ai/dsh-credentials` 的 `credentialRef`;`@deepseek-ai/dsh-launch-environment` 的 `launchEnvironmentOf`;`@deepseek-ai/dsh-llm` 的 `resolveRetryPolicy`/`RetryPolicySchema`/`LlmError`。
- Produces: 插件 `name='raincode'`、`inject=['llm','commands']`、`Config`、`apply(ctx, config)`;`registerSkillsCommand(ctx, baseUrl)`。

- [ ] **Step 1: 写失败测试(commands)**

`src/commands.spec.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { registerSkillsCommand } from './commands.js'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'

let server: Server
let port = 0

async function start(): Promise<void> {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ skills: [
      { name: 'coding-cycle', category: 'workflow.coding', description: 'full cycle', body: '# Coding\nsteps' },
      { name: 'git-discipline', category: 'workflow.git', description: 'commit discipline', body: '# Git\nrules' },
    ] }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const a = server.address()
  if (a && typeof a === 'object') port = a.port
}

describe('skills command', () => {
  it('lists skills without input and shows body with a name', async () => {
    await start()
    try {
      const registered: { name: string; handler: (inv: CommandInvocation) => CommandResult | Promise<CommandResult> }[] = []
      const fakeCtx = {
        commands: { register: (def: { name: string; handler: (inv: CommandInvocation) => CommandResult | Promise<CommandResult> }) => { registered.push(def); return () => {} } },
      } as never
      registerSkillsCommand(fakeCtx, () => `http://127.0.0.1:${port}`)
      const cmd = registered[0]
      expect(cmd.name).toBe('skills')
      const list = await cmd.handler({ rawInput: '', signal: new AbortController().signal } as CommandInvocation)
      expect(list.kind).toBe('success')
      const text = (list as { text: string }).text
      expect(text).toContain('coding-cycle')
      const detail = await cmd.handler({ rawInput: 'git-discipline', signal: new AbortController().signal } as CommandInvocation)
      expect((detail as { text: string }).text).toContain('# Git')
      const missing = await cmd.handler({ rawInput: 'nope', signal: new AbortController().signal } as CommandInvocation)
      expect(missing.kind).toBe('error')
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL(`Cannot find module './commands.js'`)。

- [ ] **Step 3: 实现 `src/commands.ts`**

```ts
import type { CommandResult } from '@deepseek-ai/dsh-commands'

interface SkillItem {
  name: string
  category: string
  description: string
  body: string
}

/**
 * 注册 `/skills` 命令:无参数 → 列清单;`/skills <name>` → 看正文。数据来自
 * raincode gateway 的 `/skills`(Rust 侧 SkillStore::discover,不重复解析)。
 */
export function registerSkillsCommand(ctx: { commands: { register: (def: { name: string; description: string; input?: { hint: string }; handler: (inv: { rawInput: string; signal: AbortSignal }) => CommandResult | Promise<CommandResult> }) => unknown } }, baseUrl: () => string): void {
  ctx.commands.register({
    name: 'skills',
    description: 'Browse raincode skills (no arg = list, /skills <name> = view body)',
    input: { hint: '<skill name>' },
    async handler(invocation) {
      const name = invocation.rawInput.trim()
      const url = `${baseUrl().replace(/\/+$/, '')}/skills`
      try {
        const resp = await fetch(url, { signal: invocation.signal })
        if (!resp.ok) throw new Error(`raincode gateway ${resp.status}`)
        const data = (await resp.json()) as { skills: SkillItem[] }
        const skills = data.skills ?? []
        if (name === '') {
          if (skills.length === 0) return { kind: 'success' as const, text: 'no raincode skills found' }
          const lines = skills.map((s) => `- **${s.name}** (${s.category}): ${s.description}`)
          return { kind: 'success' as const, text: `raincode skills (${skills.length})\n\n${lines.join('\n')}` }
        }
        const match = skills.find((s) => s.name === name)
        if (match === undefined) return { kind: 'error' as const, text: `skill "${name}" not found` }
        return { kind: 'success' as const, text: `# ${match.name} (${match.category})\n\n${match.body}` }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { kind: 'error' as const, text: `skills: ${message}` }
      }
    },
  })
}
```

- [ ] **Step 4: 实现 `src/index.ts`**

```ts
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { LlmError, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import { RaincodeAdapter, type RaincodeConnectionOptions, type RaincodeModel } from './adapter.js'
import { registerSkillsCommand } from './commands.js'

export const name = 'raincode'
export const inject = ['llm', 'commands']

const NS = settingsNamespace('raincode')
const PROVIDER = 'raincode'
const DEFAULT_BASE_URL = 'http://127.0.0.1:8787'
const DEFAULT_API_KEY_ENV = 'RAINCODE_API_KEY'

export interface Config {
  baseURL?: string
  apiKeyEnv?: string
  models?: RaincodeModel[]
  streamIdleTimeoutMs?: number
  retryPolicy?: unknown
}

const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
})

export const Config: z<Config> = z.object({
  baseURL: z.string().default(DEFAULT_BASE_URL),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  models: z.array(catalogModel).default([]),
  streamIdleTimeoutMs: z.number().min(1).default(300_000),
  retryPolicy: RetryPolicySchema,
})

function resolveConnection(config: Config): RaincodeConnectionOptions {
  return {
    baseURL: config.baseURL ?? DEFAULT_BASE_URL,
    models: config.models ?? [],
    streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? 300_000,
  }
}

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: RaincodeConnectionOptions | undefined
  const options = (): RaincodeConnectionOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    const next = resolveConnection(raw)
    lastRaw = raw
    lastGood = next
    return next
  }
  options()

  const resolveApiKey = async (): Promise<string> => {
    const ref = credentialRef(current().apiKeyEnv ?? DEFAULT_API_KEY_ENV)
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return hit.value
    } else {
      const ambient = launchEnvironmentOf(ctx).get(ref)
      if (ambient !== undefined && ambient.value.length > 0) return ambient.value
    }
    // 本地 gateway 不校验 key;这里只满足 dsh 凭据接缝。仍给出可操作报错。
    throw new LlmError(
      `raincode: no API key for provider "${PROVIDER}"; export ${ref} (the local gateway ignores it)`,
      'MISSING_CREDENTIAL',
    )
  }

  const adapter = new RaincodeAdapter({ options, resolveApiKey })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'Raincode', settingsNs: NS, settingsPath: [] },
  ])
  ctx.llm.registerAdapter([PROVIDER], adapter)
  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => { current = source },
    onChange: () => {},
  })
  registerSkillsCommand(ctx, () => options().baseURL)
}
```

- [ ] **Step 5: 运行确认通过**

Run: `npm test && npm run typecheck`
Expected: 全部 PASS,typecheck 无错。

- [ ] **Step 6: 全量回归 + build**

Run: `npm test && npm run build`
Expected:PASS;`lib/` 产出 `index.js` + `index.d.ts`。

- [ ] **Step 7: Commit**

```bash
git add src/index.ts src/commands.ts src/commands.spec.ts
git commit -m "feat: plugin entry (Config/apply) + /skills command"
```

---

## Task 10: README + 端到端冒烟(wire 级)

**Files:**
- Create: `G:/claude codex_workspace/dsh-plugins-raincode/README.md`

- [ ] **Step 1: 写 README**

`README.md` 内容要点(英文,面向 dsh 用户):
- 标题 + 一句话:让 dsh 的模型层 = raincode(模型池 / 缓存 / 重试),并可在 dsh 内选模型、`/skills` 查看 skill 库。
- 前置:安装 raincode(`cargo install --path crates/rc-cli` 或 `install.sh`),配置 `raincode setup`,启动 `raincode proxy --port 8787`。
- 安装:dsh 的 cordis.yml 引用本插件(`npm i dsh-plugins-raincode`)。
- 配置示例:
```yaml
- id: raincode
  name: dsh-plugins-raincode
  config:
    baseURL: http://127.0.0.1:8787
    apiKeyEnv: RAINCODE_API_KEY
```
- 能力:模型选择器里看到 raincode 池;`/skills` 浏览;缓存/重试由 gateway 兜底。
- FAQ:gateway 未启动怎么办、为什么 key 是摆设、如何加模型(`raincode setup`)。
- License:MIT。

- [ ] **Step 2: wire 级端到端(真 gateway + 真上游)**

```bash
# raincode 仓库侧
cd "G:/claude codex_workspace/raincode-iter"
cargo run -p rc-cli -- proxy --port 8787 &   # 用你的真实 profiles.toml + opencode.ai key
sleep 4
# 插件侧冒烟:直接 curl gateway 验证 [DONE]/usage
curl -sN http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"say ok"}],"stream":true,"max_tokens":8}' \
  | grep -E 'DONE|usage|finish_reason' | head -5
kill %1
```
Expected:末尾见 `data: [DONE]`,且 finish 前有 `usage`(含 `prompt_tokens`)。

- [ ] **Step 3: 真实模型对话冒烟(可选,耗 key)**

在插件目录用 node 直跑 adapter:
```bash
cd "G:/claude codex_workspace/dsh-plugins-raincode"
RAINCODE_API_KEY=whatever node --experimental-strip-types --input-type=module -e "
import { RaincodeAdapter } from './src/adapter.ts'
const a = new RaincodeAdapter({ options: () => ({ baseURL: 'http://127.0.0.1:8787', apiKey: 'x', models: [], streamIdleTimeoutMs: 30000 }), resolveApiKey: async () => 'x' })
for await (const c of a.stream({ provider: 'raincode', model: 'deepseek-v4-flash', messages: [{ id: 'm', role: 'user', content: [{ type: 'text', text: 'hi, one word' }], source: { kind: 'user' } }], maxTokens: 16 })) {
  if (c.type === 'text-delta') process.stdout.write(c.text)
  if (c.type === 'finish') console.log('\n[finish]', c.reason.kind)
}
"
```
Expected:打印模型回复 + `[finish] stop`。(若 `--experimental-strip-types` 不可用,改用 `npx tsx`。)

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: README — dsh 模型层 = raincode 的接入与配置"
```

---

## Task 11: GitHub 建仓 + topics + 推送

**Files:**
- Run: `gh` / `git remote`

- [ ] **Step 1: 建仓(GitHub `rainforest888/dsh-plugins-raincode`)**

```bash
cd "G:/claude codex_workspace/dsh-plugins-raincode"
gh repo create rainforest888/dsh-plugins-raincode --public --source=. --push \
  --description "dsh plugin: DeepSeek Harness 的模型层 = raincode(模型池/缓存/重试) + /skills 浏览"
```
Expected:成功,push 全部提交。`gh` 已登录 `rainforest888`(token scope 含 repo)。(`gh repo create` 无 `--add-topic`,话题在 Step 2 用 `gh repo edit` 单独加。)

- [ ] **Step 2: 加 18 个 topics**

```bash
cd "G:/claude codex_workspace/dsh-plugins-raincode"
gh repo edit rainforest888/dsh-plugins-raincode \
  --add-topic dsh-plugin --add-topic raincode --add-topic deepseek-harness --add-topic deepseek \
  --add-topic llm --add-topic llm-gateway --add-topic openai-compatible --add-topic agent-harness \
  --add-topic ai-agent --add-topic coding-agent --add-topic model-routing --add-topic model-pool \
  --add-topic prompt-caching --add-topic cost-optimization --add-topic multi-model \
  --add-topic typescript --add-topic rust --add-topic plugin
```

- [ ] **Step 3: 验证 topics 与远端**

```bash
gh repo view rainforest888/dsh-plugins-raincode --json url,repositoryTopics -q '.url, (.repositoryTopics|map(.name))'
git -C "G:/claude codex_workspace/dsh-plugins-raincode" remote -v
```
Expected:显示 18 个 topics;remote 指向新仓。

---

## Task 12: npm publish

**Files:**
- Run: `npm publish`

**前置条件:** 用户已确认发布;npm 已登录(`npm whoami` = `rainforest888`)。

- [ ] **Step 1: 确认包内容与版本**

```bash
cd "G:/claude codex_workspace/dsh-plugins-raincode"
npm run build
npm pack --dry-run | head -30
```
Expected:`lib/`、`README.md`、`LICENSE` 在列;无 `src/**/*.spec.ts`。

- [ ] **Step 2: 发布**

```bash
npm publish --access public
```
Expected:输出 `+ dsh-plugins-raincode@0.1.0`。若提示需 OTP:`npm publish --access public --otp <code>`(用户从邮箱取最新验证码)。

- [ ] **Step 3: 验证**

```bash
npm view dsh-plugins-raincode version
npm view dsh-plugins-raincode --json | python -c "import json,sys; d=json.load(sys.stdin); print('homepage:', d.get('homepage')); print('desc:', (d.get('description') or '')[:60])"
```
Expected:版本 `0.1.0`,描述正确。

---

## Self-Review(执行前核对)

- **规格覆盖**:规格 §3.1 六项(gateway)↔ Task 2/3/4;§3.2(插件文件/Config/命令)↔ Task 5–9;§4(wire 契约)↔ Task 3/6/7/8;§5(错误)↔ Task 8 `mapHttpError`;§6(测试)↔ 各 Task 测试;§7(交付/topics/README/发布)↔ Task 10/11/12;§8 范围外(route 接入、skill 导航注入、/v1/messages、鉴权)— 不做。
- **占位符**:无 TBD/TODO;每个改代码步骤都有完整代码。
- **类型一致**:`RaincodeConnectionOptions.baseURL/apiKey/models/streamIdleTimeoutMs` 在 Task 8 定义、Task 9 `resolveConnection` 使用,字段名一致;`serializeRequest`/`translateChunk`/`createTranslateState`/`registerSkillsCommand` 签名跨 Task 一致。
