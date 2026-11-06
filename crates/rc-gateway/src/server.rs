//! CC-Switch-style HTTP gateway. Exposes the active Raincode profile as
//! OpenAI-compatible (`/v1/chat/completions`, `/v1/embeddings`) and
//! Anthropic-compatible (`/v1/messages`) endpoints, plus a live `/switch`
//! endpoint for changing the active profile without restarting clients.

use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::task::{Context, Poll};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::{Stream, StreamExt};
use rc_capability;
use rc_pro::canonical::{
    CanonicalMessage, CanonicalRequest, CanonicalToolCall, ProvEvent, ToolDef,
};
use rc_pro::provider::ProvStream;
use rc_pro::{create_provider, Provider, ProviderError};
use rc_profile::model::{Profile, Registry};
use rc_profile::writers::all_writers;
use rc_skill::SkillStore;
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Debug, thiserror::Error)]
pub enum GatewayError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("registry error: {0}")]
    Registry(#[from] rc_profile::model::RegistryError),
    #[error("provider error: {0}")]
    Provider(#[from] ProviderError),
    #[error("lock poisoned")]
    Poisoned,
    #[error("{0}")]
    Switch(String),
    #[error("{0}")]
    BadRequest(String),
    #[error("server error: {0}")]
    Server(String),
}

#[derive(Debug, Clone)]
pub struct GatewayConfig {
    pub addr: std::net::SocketAddr,
    pub registry_path: PathBuf,
    pub skills_dir: PathBuf,
    /// 是否启动后台任务,每 7 天刷新一次 opencode 调用量前 N 的模型能力。
    pub capability_weekly_refresh: bool,
    pub capability_top_n: usize,
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
            capability_weekly_refresh: true,
            capability_top_n: 15,
        }
    }
}

pub struct GatewayState {
    registry_path: PathBuf,
    skills_dir: PathBuf,
    registry: RwLock<Registry>,
    capability_lock: Arc<tokio::sync::Mutex<()>>,
    request_logs: std::sync::Mutex<VecDeque<RequestLog>>,
}

impl GatewayState {
    fn active_profile(&self) -> Result<Profile, GatewayError> {
        let registry = self.registry.read().map_err(|_| GatewayError::Poisoned)?;
        registry
            .active()
            .cloned()
            .ok_or_else(|| GatewayError::Switch("no active profile".into()))
    }

    /// 按 `model` 精确匹配 profile.model 或 profile.id;未命中返回 None(调用方回退 active)。
    fn profile_for_model(&self, model: &str) -> Option<Profile> {
        let registry = self.registry.read().ok()?;
        registry
            .profiles
            .iter()
            .find(|p| p.model == model || p.id == model)
            .cloned()
    }

    fn provider(&self) -> Result<Box<dyn Provider>, GatewayError> {
        let profile = self.active_profile()?;
        let mut cfg = profile.to_provider_config();
        // 与 rc-cli 一致:api_key_file / api_key_env 指向的 key 也要解析进
        // ProviderConfig(否则 key-file 型 profile 到上游就是 "Missing API key")。
        if cfg.api_key.is_none() {
            cfg.api_key = profile.resolved_api_key()?;
        }
        Ok(create_provider(cfg)?)
    }

    fn switch(&self, id_or_name: &str) -> Result<Profile, GatewayError> {
        let mut registry = self.registry.write().map_err(|_| GatewayError::Poisoned)?;
        let profile = registry
            .profiles
            .iter()
            .find(|p| p.id == id_or_name || p.name == id_or_name)
            .cloned()
            .ok_or_else(|| GatewayError::Switch(format!("profile not found: {id_or_name}")))?;
        registry.set_active(&profile.id)?;
        registry.save(&self.registry_path)?;
        Ok(profile)
    }

    fn record_request_log(&self, log: RequestLog) {
        let mut logs = self
            .request_logs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if logs.len() >= REQUEST_LOG_CAPACITY {
            logs.pop_front();
        }
        logs.push_back(log);
    }

    fn request_logs_snapshot(&self) -> Vec<RequestLog> {
        self.request_logs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .cloned()
            .collect()
    }
}

#[derive(Debug, Deserialize)]
struct ChatBody {
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    messages: Vec<Value>,
    #[serde(default)]
    tools: Vec<Value>,
    #[serde(default)]
    stream: bool,
    #[serde(default)]
    temperature: Option<f32>,
    #[serde(default)]
    max_tokens: Option<u32>,
    #[serde(default)]
    stop: Option<Vec<String>>,
    #[serde(default)]
    reasoning_effort: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    purpose: Option<String>,
}

/// 请求日志上限,满了丢最旧。
const REQUEST_LOG_CAPACITY: usize = 200;
static REQUEST_LOG_SEQ: AtomicU64 = AtomicU64::new(1);

/// `/requests` 返回的一条请求记录,用于 dsh 插件展示主控/子代理调用状况。
#[derive(Debug, Clone, serde::Serialize)]
struct RequestLog {
    id: String,
    model: String,
    session_id: Option<String>,
    purpose: Option<String>,
    stream: bool,
    status: String,
    finish_reason: Option<String>,
    duration_ms: u64,
    usage: Option<Value>,
    error: Option<String>,
    tools_count: usize,
}

fn next_request_log_id() -> String {
    format!(
        "req-{}-{}",
        now_ts(),
        REQUEST_LOG_SEQ.fetch_add(1, Ordering::Relaxed)
    )
}

#[allow(clippy::too_many_arguments)] // 调用点都是同一请求日志模式,合并结构体会放大改动面
fn new_request_log(
    model: String,
    session_id: Option<String>,
    purpose: Option<String>,
    stream: bool,
    tools_count: usize,
    started: Instant,
    status: &str,
    finish_reason: Option<String>,
    usage: Option<Value>,
    error: Option<String>,
) -> RequestLog {
    RequestLog {
        id: next_request_log_id(),
        model,
        session_id,
        purpose,
        stream,
        status: status.to_string(),
        finish_reason,
        duration_ms: started.elapsed().as_millis() as u64,
        usage,
        error,
        tools_count,
    }
}

#[derive(Debug, Deserialize)]
struct MessagesBody {
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    max_tokens: Option<u32>,
    #[serde(default)]
    system: Option<Value>,
    #[serde(default)]
    messages: Vec<Value>,
    #[serde(default)]
    tools: Vec<Value>,
    #[serde(default)]
    stream: bool,
}

#[derive(Debug, Deserialize)]
struct EmbeddingBody {
    #[serde(default)]
    model: Option<String>,
    input: Value,
}

#[derive(Debug, Deserialize)]
struct SwitchBody {
    profile: String,
    #[serde(default)]
    app: Option<String>,
    #[serde(default)]
    write_target: bool,
}

pub async fn serve(config: GatewayConfig) -> Result<(), GatewayError> {
    let mut registry = Registry::load(&config.registry_path)?;
    registry.ensure_default();
    let _ = registry.save(&config.registry_path);
    let state = Arc::new(GatewayState {
        registry_path: config.registry_path,
        skills_dir: config.skills_dir,
        registry: RwLock::new(registry),
        capability_lock: Arc::new(tokio::sync::Mutex::new(())),
        request_logs: std::sync::Mutex::new(VecDeque::new()),
    });
    if config.capability_weekly_refresh {
        let top = config.capability_top_n.max(1);
        let job_state = state.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(7 * 24 * 3600));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            // 第一次 tick 是立即触发;跳过,从 7 天后开始周更。
            interval.tick().await;
            loop {
                interval.tick().await;
                let _guard = job_state.capability_lock.lock().await;
                match rc_capability::refresh_top_models(top).await {
                    Ok(profiles) => tracing::info!(
                        "weekly capability refresh completed: {} profiles",
                        profiles.len()
                    ),
                    Err(e) => tracing::warn!("weekly capability refresh failed: {e}"),
                }
            }
        });
    }
    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/chat/completions", post(chat_completions))
        .route("/v1/models", get(models))
        .route("/skills", get(skills))
        .route("/v1/messages", post(messages))
        .route("/v1/embeddings", post(embeddings))
        .route("/profiles", get(get_profiles).put(put_profiles))
        .route("/capabilities", get(capabilities))
        .route("/capabilities/refresh", post(capability_refresh))
        .route("/capabilities/refresh-top", post(capability_refresh_top))
        .route("/learn", post(learn))
        .route("/switch", post(switch_profile))
        .route("/requests", get(requests))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind(config.addr)
        .await
        .map_err(|e| GatewayError::Server(e.to_string()))?;
    tracing::info!("raincode gateway listening on {}", config.addr);
    axum::serve(listener, app)
        .await
        .map_err(|e| GatewayError::Server(e.to_string()))
}

async fn health() -> Json<Value> {
    Json(json!({"ok": true, "service": "raincode-gateway"}))
}

/// dsh 插件轮询调用状况:返回最近 200 条请求日志,新的在前端可直接渲染。
async fn requests(State(state): State<Arc<GatewayState>>) -> Json<Value> {
    Json(json!({"requests": state.request_logs_snapshot()}))
}

#[derive(Debug, Deserialize)]
struct ProfilesBody {
    #[serde(default)]
    profiles: Vec<Profile>,
}

async fn get_profiles(State(state): State<Arc<GatewayState>>) -> Response {
    let registry = match state.registry.read() {
        Ok(r) => r,
        Err(_) => return gateway_error(StatusCode::INTERNAL_SERVER_ERROR, "lock poisoned".into()),
    };
    Json(json!({"profiles": registry.profiles})).into_response()
}

/// 全量替换模型池。dsh 插件把设置 UI 里的 profiles 同步到这里;
/// 本端点是 loopback 本地管理面,不做鉴权。api_key 仍随 Profile 序列化,
/// 插件侧负责脱敏与安全存储。
async fn put_profiles(
    State(state): State<Arc<GatewayState>>,
    Json(body): Json<ProfilesBody>,
) -> Response {
    let mut registry = match state.registry.write() {
        Ok(r) => r,
        Err(_) => return gateway_error(StatusCode::INTERNAL_SERVER_ERROR, "lock poisoned".into()),
    };
    registry.profiles = body.profiles;
    if registry.profiles.is_empty() {
        registry.ensure_default();
    } else {
        let active_exists = registry
            .active_id
            .as_ref()
            .map(|id| registry.profiles.iter().any(|p| &p.id == id))
            .unwrap_or(false);
        if !active_exists {
            registry.active_id = registry.profiles.first().map(|p| p.id.clone());
        }
    }
    if let Err(e) = registry.save(&state.registry_path) {
        return gateway_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }
    Json(json!({"ok": true, "profiles": registry.profiles})).into_response()
}

#[derive(Debug, Deserialize)]
struct CapabilityRefreshBody {
    #[serde(default)]
    model: String,
    #[serde(default)]
    top: Option<usize>,
}

async fn capabilities(State(_state): State<Arc<GatewayState>>) -> Response {
    match rc_capability::load_profiles() {
        Ok(map) => Json(json!({"profiles": map.into_values().collect::<Vec<_>>()})).into_response(),
        Err(e) => gateway_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn capability_refresh(
    State(state): State<Arc<GatewayState>>,
    Json(body): Json<CapabilityRefreshBody>,
) -> Response {
    if body.model.trim().is_empty() {
        return gateway_error(StatusCode::BAD_REQUEST, "model must not be empty".into());
    }
    let _guard = state.capability_lock.lock().await;
    match rc_capability::refresh_model(&body.model).await {
        Ok(profile) => Json(profile).into_response(),
        Err(e) => gateway_error(StatusCode::BAD_GATEWAY, e.to_string()),
    }
}

async fn capability_refresh_top(
    State(state): State<Arc<GatewayState>>,
    Json(body): Json<CapabilityRefreshBody>,
) -> Response {
    let top = body
        .top
        .unwrap_or(rc_capability::DEFAULT_TOP_N)
        .clamp(1, 100);
    let _guard = state.capability_lock.lock().await;
    match rc_capability::refresh_top_models(top).await {
        Ok(profiles) => Json(json!({"refreshed": profiles})).into_response(),
        Err(e) => gateway_error(StatusCode::BAD_GATEWAY, e.to_string()),
    }
}

#[derive(Debug, Deserialize)]
struct LearnBody {
    /// 这次要沉淀的任务/主题描述。
    task: String,
    /// 可选:模型整理出的会话摘录/经验(不传则由主控模型只根据 task 生成)。
    #[serde(default)]
    transcript: Option<String>,
    /// 可选:skill 名;不传则让主控模型在 frontmatter 里起名。
    #[serde(default)]
    name: Option<String>,
    /// 可选:category;不传默认 `learned`.
    #[serde(default)]
    category: Option<String>,
}

fn learn_prompt(body: &LearnBody) -> String {
    let transcript = body.transcript.as_deref().unwrap_or("").trim();
    let name_hint = match body.name.as_deref() {
        Some(name) if !name.trim().is_empty() => format!("Use exactly this skill name: {name}
"),
        _ => String::new(),
    };
    let category_hint = match body.category.as_deref() {
        Some(cat) if !cat.trim().is_empty() => format!("Use exactly this category: {cat}
"),
        _ => String::new(),
    };
    format!(
        "You are the raincode skill editor. Convert the task/experience below into ONE short SKILL.md.
         {name_hint}{category_hint}         Rules:
         - Output ONLY valid SKILL.md: YAML frontmatter between `---` lines, then a short checklist body.
         - Frontmatter must include name, description, category, triggers (array), tags (array).
         - Body must be a concise decision/checklist, no long prose, at most 20 lines.
         - This is a leaf skill: it must have a complete body, not an index menu.

         Task: {}

         Experience/transcript:
{}
",
        body.task.trim(),
        if transcript.is_empty() { "(none provided)" } else { transcript }
    )
}

async fn learn(
    State(state): State<Arc<GatewayState>>,
    Json(body): Json<LearnBody>,
) -> Response {
    if body.task.trim().is_empty() {
        return gateway_error(StatusCode::BAD_REQUEST, "task must not be empty".into());
    }
    let provider = match state.provider() {
        Ok(p) => p,
        Err(e) => return gateway_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let prompt = learn_prompt(&body);
    let request = CanonicalRequest {
        model: provider.id().to_string(),
        messages: vec![
            CanonicalMessage::system("You are a skill editor. Return only valid SKILL.md."),
            CanonicalMessage::user(prompt),
        ],
        tools: vec![],
        temperature: Some(0.3),
        max_tokens: Some(1600),
        stream: true,
        extra: json!({}),
    };
    let mut stream = match provider.stream(request).await {
        Ok(s) => s,
        Err(e) => return gateway_error(StatusCode::BAD_GATEWAY, e.to_string()),
    };
    let mut raw = String::new();
    while let Some(event) = stream.next().await {
        match event {
            Ok(rc_pro::ProvEvent::Delta { text }) => raw.push_str(&text),
            Ok(rc_pro::ProvEvent::Error { message }) => {
                return gateway_error(StatusCode::BAD_GATEWAY, message)
            }
            Err(e) => return gateway_error(StatusCode::BAD_GATEWAY, e.to_string()),
            Ok(_) => {}
        }
    }
    if raw.trim().is_empty() {
        return gateway_error(StatusCode::BAD_GATEWAY, "main model returned empty SKILL.md".into());
    }
    let (fm, skill_body) = match rc_skill::parse_frontmatter(&raw) {
        Ok(v) => v,
        Err(e) => return gateway_error(StatusCode::BAD_GATEWAY, format!("invalid SKILL.md: {e}")),
    };
    let skill = rc_skill::Skill::from_frontmatter(fm, skill_body, PathBuf::new());
    if skill.name.trim().is_empty() {
        return gateway_error(StatusCode::BAD_GATEWAY, "SKILL.md has empty name".into());
    }
    let skill_store = SkillStore::new(&state.skills_dir);
    // 学习产物一律进 review 隔离区,用户 approve 后才转正。
    let mut staged = skill;
    staged.scope = "review".into();
    staged.auto = true;
    staged.origin = "evolved".into();
    staged.confidence = staged.confidence.max(0.6);
    staged.version = staged.version.max(1);
    staged.allow_implicit = true;
    match skill_store.save(&staged) {
        Ok(path) => Json(json!({
            "ok": true,
            "review": true,
            "path": path.to_string_lossy(),
            "skill": {
                "name": staged.name,
                "category": staged.category,
                "description": staged.description,
                "body": staged.body,
            }
        }))
        .into_response(),
        Err(e) => gateway_error(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

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
        .map(|s| {
            json!({
                "name": s.name,
                "category": s.category,
                "description": s.description,
                "tags": s.tags,
                "body": s.body,
            })
        })
        .collect();
    Json(json!({"skills": items})).into_response()
}

async fn chat_completions(
    State(state): State<Arc<GatewayState>>,
    Json(body): Json<ChatBody>,
) -> Response {
    let started = Instant::now();
    let stream_mode = body.stream;
    let tools_count = body.tools.len();
    let session_id = body.session_id.clone();
    let purpose = body.purpose.clone();

    let model = body.model.clone();
    let profile = {
        let picked = match model.as_deref() {
            Some(m) => state
                .profile_for_model(m)
                .or_else(|| state.active_profile().ok()),
            None => state.active_profile().ok(),
        };
        match picked {
            Some(p) => p,
            None => {
                let fallback_model = model
                    .clone()
                    .filter(|m| !m.is_empty())
                    .unwrap_or_else(|| "unknown".into());
                state.record_request_log(new_request_log(
                    fallback_model,
                    session_id,
                    purpose,
                    stream_mode,
                    tools_count,
                    started,
                    "error",
                    None,
                    None,
                    Some("no profile for model".into()),
                ));
                return gateway_error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "no profile for model".into(),
                );
            }
        }
    };
    let model = model.unwrap_or_else(|| profile.model.clone());
    let messages = match openai_messages(&body.messages) {
        Ok(m) => m,
        Err(e) => {
            state.record_request_log(new_request_log(
                model.clone(),
                session_id,
                purpose,
                stream_mode,
                tools_count,
                started,
                "error",
                None,
                None,
                Some(e.clone()),
            ));
            return gateway_error(StatusCode::BAD_REQUEST, e);
        }
    };
    let tools = openai_tools(&body.tools);
    let provider = match state.provider() {
        Ok(p) => p,
        Err(e) => {
            state.record_request_log(new_request_log(
                model.clone(),
                session_id,
                purpose,
                stream_mode,
                tools_count,
                started,
                "error",
                None,
                None,
                Some(e.to_string()),
            ));
            return gateway_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
    };
    let request = CanonicalRequest {
        model: model.clone(),
        messages,
        tools,
        temperature: body.temperature,
        max_tokens: body.max_tokens,
        stream: body.stream,
        extra: build_request_extra(
            body.stop.as_ref(),
            body.reasoning_effort.as_deref(),
            body.session_id.as_deref(),
        ),
    };
    let stream = match provider.stream(request).await {
        Ok(s) => s,
        Err(e) => {
            state.record_request_log(new_request_log(
                model.clone(),
                session_id,
                purpose,
                stream_mode,
                tools_count,
                started,
                "error",
                None,
                None,
                Some(e.to_string()),
            ));
            return gateway_error(StatusCode::BAD_GATEWAY, e.to_string());
        }
    };

    if body.stream {
        let base = RequestLog {
            id: next_request_log_id(),
            model: model.clone(),
            session_id,
            purpose,
            stream: true,
            status: "ok".to_string(),
            finish_reason: None,
            duration_ms: 0,
            usage: None,
            error: None,
            tools_count,
        };
        let stream = log_provider_stream(stream, state.clone(), started, base);
        let id = format!("chatcmpl-{}", now_ts());
        let stream = stream_openai_events(stream, &id, &model);
        return Sse::new(stream)
            .keep_alive(KeepAlive::default())
            .into_response();
    }

    let mut content = String::new();
    let mut tool_calls = Vec::new();
    let mut finish_reason = "stop".to_string();
    let mut usage = Value::Null;
    for event in stream.collect::<Vec<_>>().await {
        match event {
            Ok(rc_pro::ProvEvent::Delta { text }) => content.push_str(&text),
            Ok(rc_pro::ProvEvent::ToolCall {
                id,
                name,
                arguments,
            }) => tool_calls.push(json!({
                "id": id,
                "type": "function",
                "function": {"name": name, "arguments": arguments.to_string()}
            })),
            Ok(rc_pro::ProvEvent::Finish {
                stop_reason,
                usage: u,
            }) => {
                finish_reason = stop_reason;
                usage = u.unwrap_or(Value::Null);
            }
            Ok(rc_pro::ProvEvent::Error { message }) => {
                state.record_request_log(new_request_log(
                    model.clone(),
                    session_id,
                    purpose,
                    stream_mode,
                    tools_count,
                    started,
                    "error",
                    None,
                    None,
                    Some(message.clone()),
                ));
                return gateway_error(StatusCode::BAD_GATEWAY, message);
            }
            Ok(_) => {}
            Err(e) => {
                state.record_request_log(new_request_log(
                    model.clone(),
                    session_id,
                    purpose,
                    stream_mode,
                    tools_count,
                    started,
                    "error",
                    None,
                    None,
                    Some(e.to_string()),
                ));
                return gateway_error(StatusCode::BAD_GATEWAY, e.to_string());
            }
        }
    }
    let log_usage = if usage.is_null() {
        None
    } else {
        Some(usage.clone())
    };
    state.record_request_log(new_request_log(
        model.clone(),
        session_id,
        purpose,
        stream_mode,
        tools_count,
        started,
        "ok",
        Some(finish_reason.clone()),
        log_usage,
        None,
    ));
    let mut message = json!({
        "role": "assistant",
        "content": content,
        "tool_calls": tool_calls
    });
    if let Value::Object(ref mut obj) = message {
        if obj
            .get("tool_calls")
            .and_then(Value::as_array)
            .map(Vec::is_empty)
            .unwrap_or(true)
        {
            obj.remove("tool_calls");
        }
    }
    Json(json!({
        "id": format!("chatcmpl-{}", now_ts()),
        "object": "chat.completion",
        "created": now_ts(),
        "model": model,
        "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}],
        "usage": usage
    }))
    .into_response()
}

async fn messages(
    State(state): State<Arc<GatewayState>>,
    Json(body): Json<MessagesBody>,
) -> Response {
    let profile = match state.active_profile() {
        Ok(p) => p,
        Err(e) => return gateway_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let model = body.model.clone().unwrap_or_else(|| profile.model.clone());
    let mut canonical = match anthropic_messages(&body.system, &body.messages) {
        Ok(m) => m,
        Err(e) => return gateway_error(StatusCode::BAD_REQUEST, e),
    };
    if let Some(system) = &body.system {
        let text = system_text(system);
        if !text.is_empty() {
            canonical.insert(0, CanonicalMessage::system(text));
        }
    }
    let tools = anthropic_tools(&body.tools);
    let provider = match state.provider() {
        Ok(p) => p,
        Err(e) => return gateway_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let request = CanonicalRequest {
        model: model.clone(),
        messages: canonical,
        tools,
        temperature: None,
        max_tokens: body.max_tokens,
        stream: body.stream,
        extra: json!({}),
    };
    let stream = match provider.stream(request).await {
        Ok(s) => s,
        Err(e) => return gateway_error(StatusCode::BAD_GATEWAY, e.to_string()),
    };
    if body.stream {
        let id = format!("msg_{}", now_ts());
        let stream = stream.map(move |event| {
            let data = match event {
                Ok(rc_pro::ProvEvent::Delta { text }) => {
                    let mut data = String::new();
                    data.push_str(&anthropic_event(
                        "content_block_start",
                        &id,
                        json!({
                            "index": 0,
                            "content_block": {"type": "text", "text": ""}
                        }),
                    ));
                    data.push_str(&anthropic_event(
                        "content_block_delta",
                        &id,
                        json!({
                            "index": 0,
                            "delta": {"type": "text_delta", "text": text}
                        }),
                    ));
                    data.push_str(&anthropic_event(
                        "content_block_stop",
                        &id,
                        json!({"index": 0}),
                    ));
                    data.push_str(&anthropic_event(
                        "message_delta",
                        &id,
                        json!({
                            "delta": {"stop_reason": "end_turn"}
                        }),
                    ));
                    data
                }
                Ok(rc_pro::ProvEvent::ToolCall {
                    id: call_id,
                    name,
                    arguments,
                }) => anthropic_event(
                    "content_block_start",
                    &id,
                    json!({
                        "index": 0,
                        "content_block": {
                            "type": "tool_use",
                            "id": call_id,
                            "name": name,
                            "input": arguments
                        }
                    }),
                ),
                Ok(rc_pro::ProvEvent::Finish { stop_reason, .. }) => anthropic_event(
                    "message_delta",
                    &id,
                    json!({"delta": {"stop_reason": stop_reason}}),
                ),
                Ok(rc_pro::ProvEvent::Error { .. }) => {
                    format!(
                        "event: error\ndata: {}\n\n",
                        json!({"error": {"message": "provider error"}})
                    )
                }
                Err(e) => {
                    format!(
                        "event: error\ndata: {}\n\n",
                        json!({"error": {"message": e.to_string()}})
                    )
                }
                Ok(_) => String::new(),
            };
            Ok::<Event, Infallible>(Event::default().data(data))
        });
        return Sse::new(stream)
            .keep_alive(KeepAlive::default())
            .into_response();
    }

    let mut text = String::new();
    let mut tool_uses = Vec::new();
    let mut stop_reason = "end_turn".to_string();
    for event in stream.collect::<Vec<_>>().await {
        match event {
            Ok(rc_pro::ProvEvent::Delta { text: t }) => text.push_str(&t),
            Ok(rc_pro::ProvEvent::ToolCall {
                id,
                name,
                arguments,
            }) => tool_uses.push(json!({
                "type": "tool_use",
                "id": id,
                "name": name,
                "input": arguments
            })),
            Ok(rc_pro::ProvEvent::Finish { stop_reason: s, .. }) => stop_reason = s,
            Ok(rc_pro::ProvEvent::Error { message }) => {
                return gateway_error(StatusCode::BAD_GATEWAY, message)
            }
            Ok(_) => {}
            Err(e) => return gateway_error(StatusCode::BAD_GATEWAY, e.to_string()),
        }
    }
    let mut content = Vec::new();
    if !text.is_empty() {
        content.push(json!({"type": "text", "text": text}));
    }
    content.extend(tool_uses);
    Json(json!({
        "id": format!("msg_{}", now_ts()),
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": content,
        "stop_reason": stop_reason,
        "usage": {"input_tokens": 0, "output_tokens": 0}
    }))
    .into_response()
}

async fn embeddings(
    State(state): State<Arc<GatewayState>>,
    Json(body): Json<EmbeddingBody>,
) -> Response {
    let profile = match state.active_profile() {
        Ok(p) => p,
        Err(e) => return gateway_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let model = body.model.clone().unwrap_or_else(|| profile.model.clone());
    let texts = match embedding_texts(&body.input) {
        Ok(t) => t,
        Err(e) => return gateway_error(StatusCode::BAD_REQUEST, e),
    };
    let provider = match state.provider() {
        Ok(p) => p,
        Err(e) => return gateway_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    match provider.embed(texts).await {
        Ok(vectors) => {
            let data: Vec<Value> = vectors
                .into_iter()
                .enumerate()
                .map(|(index, embedding)| {
                    json!({
                        "object": "embedding",
                        "embedding": embedding,
                        "index": index
                    })
                })
                .collect();
            Json(json!({
                "object": "list",
                "data": data,
                "model": model,
                "usage": {"prompt_tokens": 0, "total_tokens": 0}
            }))
            .into_response()
        }
        Err(e) => gateway_error(StatusCode::BAD_GATEWAY, e.to_string()),
    }
}

async fn switch_profile(
    State(state): State<Arc<GatewayState>>,
    Json(body): Json<SwitchBody>,
) -> Response {
    let profile = match state.switch(&body.profile) {
        Ok(p) => p,
        Err(e) => return gateway_error(StatusCode::NOT_FOUND, e.to_string()),
    };
    let mut written = Vec::new();
    if body.write_target {
        if let Some(app) = &body.app {
            for writer in all_writers() {
                if writer.app() == app {
                    if let Err(e) = writer.apply(&profile) {
                        return gateway_error(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            format!("failed to write {app} config: {e}"),
                        );
                    }
                    written.push(app.clone());
                }
            }
        }
    }
    Json(json!({"ok": true, "profile": profile, "written": written})).into_response()
}

/// dsh/OpenAI 兼容客户端把 stop / reasoning_effort / session_id 放在请求体顶层;
/// 这里把它们收进 `CanonicalRequest.extra`,由 rc-pro 透传(openai provider 读
/// `extra.session_id` 生成 prompt_cache_key,读 stop/reasoning_effort 转发上游)。
/// 抽取为纯函数便于单测。
fn build_request_extra(
    stop: Option<&Vec<String>>,
    reasoning_effort: Option<&str>,
    session_id: Option<&str>,
) -> Value {
    let mut extra = json!({});
    if let Some(stops) = stop {
        if !stops.is_empty() {
            extra["stop"] = json!(stops);
        }
    }
    if let Some(effort) = reasoning_effort {
        if !effort.is_empty() {
            extra["reasoning_effort"] = json!(effort);
        }
    }
    if let Some(sid) = session_id {
        if !sid.is_empty() {
            extra["session_id"] = json!(sid);
        }
    }
    extra
}

fn openai_messages(messages: &[Value]) -> Result<Vec<CanonicalMessage>, String> {
    let mut out = Vec::new();
    for value in messages {
        let obj = value
            .as_object()
            .ok_or_else(|| "message must be an object".to_string())?;
        let role = obj
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("user")
            .to_string();
        let mut content = Vec::new();
        match obj.get("content") {
            Some(Value::String(s)) if !s.is_empty() => {
                content.push(rc_pro::CanonicalContent::text(s.clone()))
            }
            Some(Value::Array(parts)) => {
                for part in parts {
                    let part_obj = part.as_object().ok_or("content part must be object")?;
                    let text = part_obj.get("text").and_then(Value::as_str);
                    if let Some(text) = text {
                        content.push(rc_pro::CanonicalContent::text(text));
                    } else if let Some(url) = part_obj
                        .get("image_url")
                        .and_then(|u| u.get("url"))
                        .and_then(Value::as_str)
                    {
                        content.push(rc_pro::CanonicalContent::Image {
                            data_url: url.to_string(),
                        });
                    }
                }
            }
            _ => {}
        }
        let mut tool_calls = Vec::new();
        if let Some(calls) = obj.get("tool_calls").and_then(Value::as_array) {
            for call in calls {
                let empty_map = serde_json::Map::new();
                let call_obj = call.as_object().unwrap_or(&empty_map);
                let id = call_obj
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("call_1")
                    .to_string();
                let function = call_obj.get("function").unwrap_or(&Value::Null);
                let name = function
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let args = function
                    .get("arguments")
                    .and_then(Value::as_str)
                    .unwrap_or("{}");
                let parsed =
                    serde_json::from_str(args).unwrap_or_else(|_| Value::String(args.to_string()));
                tool_calls.push(CanonicalToolCall {
                    id,
                    name,
                    arguments: parsed,
                });
            }
        }
        match role.as_str() {
            "system" => out.push(CanonicalMessage::system(
                content
                    .iter()
                    .filter_map(|c| match c {
                        rc_pro::CanonicalContent::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join(""),
            )),
            "tool" => {
                let text = content
                    .iter()
                    .filter_map(|c| match c {
                        rc_pro::CanonicalContent::Text { text } => Some(text.clone()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("");
                out.push(CanonicalMessage::tool(
                    obj.get("tool_call_id")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                    obj.get("name").and_then(Value::as_str).unwrap_or("tool"),
                    text,
                ));
            }
            _ => {
                let mut msg = CanonicalMessage {
                    role: rc_pro::CanonicalRole::User,
                    content,
                    tool_calls: vec![],
                    tool_call_id: None,
                    name: None,
                };
                msg.tool_calls = tool_calls;
                out.push(msg);
            }
        }
    }
    Ok(out)
}

fn openai_tools(tools: &[Value]) -> Vec<ToolDef> {
    tools
        .iter()
        .filter_map(|tool| {
            let function = tool.get("function")?;
            Some(ToolDef {
                name: function.get("name").and_then(Value::as_str)?.to_string(),
                description: function
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                input_schema: function
                    .get("parameters")
                    .cloned()
                    .unwrap_or_else(|| json!({"type": "object"})),
            })
        })
        .collect()
}

fn anthropic_messages(
    _system: &Option<Value>,
    messages: &[Value],
) -> Result<Vec<CanonicalMessage>, String> {
    let mut out = Vec::new();
    for value in messages {
        let obj = value.as_object().ok_or("message must be object")?;
        let role = obj.get("role").and_then(Value::as_str).unwrap_or("user");
        let content = obj.get("content").cloned().unwrap_or(Value::Null);
        if role == "user" {
            let mut has_text = false;
            let mut text = String::new();
            match &content {
                Value::String(s) => {
                    text.push_str(s);
                    has_text = true;
                }
                Value::Array(parts) => {
                    for part in parts {
                        let empty_map = serde_json::Map::new();
                        let p = part.as_object().unwrap_or(&empty_map);
                        if let Some(t) = p.get("text").and_then(Value::as_str) {
                            text.push_str(t);
                            has_text = true;
                        }
                    }
                }
                _ => {}
            }
            if has_text {
                out.push(CanonicalMessage::user(text));
            }
            if let Value::Array(parts) = &content {
                for part in parts {
                    let empty_map = serde_json::Map::new();
                    let p = part.as_object().unwrap_or(&empty_map);
                    if p.get("type").and_then(Value::as_str) == Some("tool_result") {
                        let id = p.get("tool_use_id").and_then(Value::as_str).unwrap_or("");
                        let result_text = match p.get("content") {
                            Some(Value::String(s)) => s.clone(),
                            Some(Value::Array(items)) => items
                                .iter()
                                .filter_map(|i| i.get("text").and_then(Value::as_str))
                                .collect::<Vec<_>>()
                                .join(""),
                            _ => String::new(),
                        };
                        out.push(CanonicalMessage::tool(id, "tool", result_text));
                    }
                }
            }
        } else {
            let mut text = String::new();
            let mut tool_calls = Vec::new();
            match &content {
                Value::String(s) => text.push_str(s),
                Value::Array(parts) => {
                    for part in parts {
                        let empty_map = serde_json::Map::new();
                        let p = part.as_object().unwrap_or(&empty_map);
                        match p.get("type").and_then(Value::as_str) {
                            Some("text") => {
                                if let Some(t) = p.get("text").and_then(Value::as_str) {
                                    text.push_str(t);
                                }
                            }
                            Some("tool_use") => {
                                tool_calls.push(CanonicalToolCall {
                                    id: p
                                        .get("id")
                                        .and_then(Value::as_str)
                                        .unwrap_or("call")
                                        .to_string(),
                                    name: p
                                        .get("name")
                                        .and_then(Value::as_str)
                                        .unwrap_or("tool")
                                        .to_string(),
                                    arguments: p.get("input").cloned().unwrap_or_else(|| json!({})),
                                });
                            }
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
            let mut msg = CanonicalMessage {
                role: rc_pro::CanonicalRole::Assistant,
                content: vec![],
                tool_calls,
                tool_call_id: None,
                name: None,
            };
            if !text.is_empty() {
                msg.content.push(rc_pro::CanonicalContent::text(text));
            }
            out.push(msg);
        }
    }
    Ok(out)
}

fn anthropic_tools(tools: &[Value]) -> Vec<ToolDef> {
    tools
        .iter()
        .filter_map(|tool| {
            Some(ToolDef {
                name: tool.get("name").and_then(Value::as_str)?.to_string(),
                description: tool
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                input_schema: tool
                    .get("input_schema")
                    .cloned()
                    .unwrap_or_else(|| json!({"type": "object"})),
            })
        })
        .collect()
}

fn system_text(system: &Value) -> String {
    match system {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

fn embedding_texts(input: &Value) -> Result<Vec<String>, String> {
    match input {
        Value::String(s) => Ok(vec![s.clone()]),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map(str::to_string)
                    .ok_or_else(|| "embedding input must be strings".to_string())
            })
            .collect(),
        _ => Err("embedding input must be a string or array".to_string()),
    }
}

fn gateway_error(status: StatusCode, message: String) -> Response {
    (status, Json(json!({"error": {"message": message}}))).into_response()
}

fn now_ts() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

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
                events.push(openai_chunk(
                    &id,
                    &model,
                    json!({"reasoning_content": text}),
                    None,
                ));
            }
            Ok(ProvEvent::ToolCall {
                id: call_id,
                name,
                arguments,
            }) => {
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

/// 包装 provider 流:在流结束/Finish/Error 时写入一条请求日志,供 `/requests` 查询。
/// 流式路径的 handler 会提前返回 SSE,因此只能在这个包装层记录日志。
struct LoggedProvStream {
    inner: ProvStream,
    state: Arc<GatewayState>,
    started: Instant,
    base: RequestLog,
    finish_reason: Option<String>,
    usage: Option<Value>,
    error: Option<String>,
    logged: bool,
}

impl Stream for LoggedProvStream {
    type Item = Result<ProvEvent, ProviderError>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.as_mut().get_mut();
        match this.inner.as_mut().poll_next(cx) {
            Poll::Ready(Some(Ok(event))) => {
                match &event {
                    ProvEvent::Finish { stop_reason, usage } => {
                        this.finish_reason = Some(stop_reason.clone());
                        this.usage = usage.clone();
                        this.write_log();
                    }
                    ProvEvent::Error { message } => {
                        this.error = Some(message.clone());
                        this.write_log();
                    }
                    _ => {}
                }
                Poll::Ready(Some(Ok(event)))
            }
            Poll::Ready(Some(Err(e))) => {
                this.error = Some(e.to_string());
                this.write_log();
                Poll::Ready(Some(Err(e)))
            }
            Poll::Ready(None) => {
                this.write_log();
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

impl LoggedProvStream {
    fn write_log(&mut self) {
        if self.logged {
            return;
        }
        self.logged = true;
        let status = if self.error.is_some() { "error" } else { "ok" };
        let mut log = self.base.clone();
        log.status = status.to_string();
        log.finish_reason = self.finish_reason.clone();
        log.usage = self.usage.clone();
        log.error = self.error.clone();
        log.duration_ms = self.started.elapsed().as_millis() as u64;
        self.state.record_request_log(log);
    }
}

fn log_provider_stream(
    inner: ProvStream,
    state: Arc<GatewayState>,
    started: Instant,
    base: RequestLog,
) -> impl Stream<Item = Result<ProvEvent, ProviderError>> {
    LoggedProvStream {
        inner,
        state,
        started,
        base,
        finish_reason: None,
        usage: None,
        error: None,
        logged: false,
    }
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

fn openai_chunk(id: &str, model: &str, delta: Value, finish: Option<&str>) -> Event {
    let data = json!({
        "id": id,
        "object": "chat.completion.chunk",
        "created": now_ts(),
        "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]
    });
    Event::default().event("message").data(data.to_string())
}

fn openai_error_chunk(id: &str, model: &str, message: &str) -> Event {
    let data = json!({
        "id": id,
        "object": "chat.completion.chunk",
        "created": now_ts(),
        "model": model,
        "choices": [{"index": 0, "delta": {}, "finish_reason": "error"}],
        "error": {"message": message}
    });
    Event::default().event("message").data(data.to_string())
}

fn anthropic_event(name: &str, id: &str, payload: Value) -> String {
    let mut payload = payload;
    if let Value::Object(ref mut obj) = payload {
        obj.insert("type".into(), Value::String(name.to_string()));
        obj.insert("message".into(), json!({"id": id, "type": "message"}));
    }
    format!("event: {name}\ndata: {}\n\n", payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use tower::util::ServiceExt;

    fn test_app() -> (Router, tempfile::TempDir) {
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
        let state = Arc::new(GatewayState {
            registry_path,
            skills_dir,
            registry: RwLock::new(registry),
            capability_lock: Arc::new(tokio::sync::Mutex::new(())),
            request_logs: std::sync::Mutex::new(VecDeque::new()),
        });
        let app = Router::new()
            .route("/health", get(health))
            .route("/v1/models", get(models))
            .route("/skills", get(skills))
            .route("/switch", post(switch_profile))
            .route("/requests", get(requests))
            .with_state(state);
        // dir 必须随 Router 一起返回:/skills 测试要读临时目录下的 SKILL.md,
        // TempDir 在 drop 时删除目录,提前 drop 会让 discover() 落空。
        (app, dir)
    }

    #[tokio::test]
    async fn stream_emits_usage_then_finish_then_done() {
        let events = vec![
            Ok::<ProvEvent, ProviderError>(ProvEvent::Delta { text: "hi".into() }),
            Ok(ProvEvent::Finish {
                stop_reason: "stop".into(),
                usage: Some(
                    serde_json::json!({"prompt_tokens": 10, "completion_tokens": 5, "prompt_tokens_details": {"cached_tokens": 3}}),
                ),
            }),
        ];
        // 经真实 SSE 序列化拿到 wire 上的 data 载荷(axum Event 无 data getter)。
        let response = Sse::new(stream_openai_events(
            futures::stream::iter(events),
            "chatcmpl-1",
            "deepseek-v4-flash",
        ))
        .into_response();
        let body = to_bytes(response.into_body(), 65536).await.unwrap();
        let text = String::from_utf8(body.to_vec()).unwrap();
        let datas: Vec<String> = text
            .lines()
            .filter_map(|l| l.strip_prefix("data: "))
            .map(str::to_string)
            .collect();
        // Delta → [usage, finish, [DONE]]
        assert_eq!(datas.len(), 4, "wire={text}");
        assert!(
            datas[0].contains("\"content\":\"hi\""),
            "first={}",
            datas[0]
        );
        assert!(datas[1].contains("\"usage\""), "usage chunk={}", datas[1]);
        assert!(
            datas[1].contains("\"choices\":[]"),
            "empty choices={}",
            datas[1]
        );
        assert!(
            datas[2].contains("\"finish_reason\":\"stop\""),
            "finish={}",
            datas[2]
        );
        assert_eq!(datas[3], "[DONE]");
    }

    #[tokio::test]
    async fn stream_assigns_tool_call_indices_by_call_id() {
        let events = vec![
            Ok::<ProvEvent, ProviderError>(ProvEvent::ToolCall {
                id: "call_a".into(),
                name: "read".into(),
                arguments: serde_json::json!({"p": 1}),
            }),
            Ok(ProvEvent::ToolCall {
                id: "call_b".into(),
                name: "write".into(),
                arguments: serde_json::json!({"p": 2}),
            }),
            Ok(ProvEvent::Finish {
                stop_reason: "tool_calls".into(),
                usage: None,
            }),
        ];
        let response = Sse::new(stream_openai_events(
            futures::stream::iter(events),
            "chatcmpl-1",
            "m",
        ))
        .into_response();
        let body = to_bytes(response.into_body(), 65536).await.unwrap();
        let text = String::from_utf8(body.to_vec()).unwrap();
        let datas: Vec<String> = text
            .lines()
            .filter_map(|l| l.strip_prefix("data: "))
            .map(str::to_string)
            .collect();
        assert_eq!(datas.len(), 4, "wire={text}");
        assert!(
            datas[0].contains("\"index\":0") && datas[0].contains("call_a"),
            "first={}",
            datas[0]
        );
        assert!(
            datas[1].contains("\"index\":1") && datas[1].contains("call_b"),
            "second={}",
            datas[1]
        );
        assert!(datas[2].contains("\"finish_reason\":\"tool_calls\""));
        assert_eq!(datas[3], "[DONE]");
    }

    #[tokio::test]
    async fn models_lists_profiles_from_registry() {
        let (app, _dir) = test_app();
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/v1/models")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = to_bytes(resp.into_body(), 65536).await.unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        let ids: Vec<String> = value["data"]
            .as_array()
            .unwrap_or(&vec![])
            .iter()
            .filter_map(|m| m["id"].as_str().map(str::to_string))
            .collect();
        // test_app 的 registry 带一个 OpenAiCompat profile(见 test_app),
        // Mock 默认 profile 会被过滤,故只断言我们加的那个。
        assert!(
            ids.contains(&"deepseek-v4-flash".to_string()),
            "ids={ids:?}"
        );
    }

    #[tokio::test]
    async fn skills_lists_skill_files() {
        let (app, _dir) = test_app();
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/skills")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = to_bytes(resp.into_body(), 65536).await.unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        let names: Vec<String> = value["skills"]
            .as_array()
            .unwrap_or(&vec![])
            .iter()
            .filter_map(|s| s["name"].as_str().map(str::to_string))
            .collect();
        assert!(
            names.contains(&"probe-skill".to_string()),
            "names={names:?}"
        );
    }

    #[tokio::test]
    async fn profile_for_model_matches_model_or_id() {
        let dir = tempfile::tempdir().unwrap();
        let registry_path = dir.path().join("profiles.toml");
        let skills_dir = dir.path().join("skills");
        std::fs::create_dir_all(&skills_dir).unwrap();
        let mut registry = Registry::default();
        registry.ensure_default();
        let mut p = registry.profiles[0].clone();
        p.id = "flash-profile".into();
        p.model = "deepseek-v4-flash".into();
        p.kind = rc_profile::model::ProfileKind::OpenAiCompat;
        registry.profiles.push(p);
        let state = Arc::new(GatewayState {
            registry_path,
            skills_dir,
            registry: RwLock::new(registry),
            capability_lock: Arc::new(tokio::sync::Mutex::new(())),
            request_logs: std::sync::Mutex::new(VecDeque::new()),
        });
        assert!(state.profile_for_model("deepseek-v4-flash").is_some());
        assert!(state.profile_for_model("flash-profile").is_some());
        assert!(state.profile_for_model("unknown-model").is_none());
    }

    #[test]
    fn learn_prompt_contains_task_and_hints() {
        let body = LearnBody {
            task: "fix a flaky rust test".into(),
            transcript: Some("use cargo test -p rc-pro".into()),
            name: Some("rust-flaky-test".into()),
            category: Some("testing.rust".into()),
        };
        let prompt = learn_prompt(&body);
        assert!(prompt.contains("rust-flaky-test"));
        assert!(prompt.contains("testing.rust"));
        assert!(prompt.contains("fix a flaky rust test"));
        assert!(prompt.contains("cargo test -p rc-pro"));
    }

    #[test]
    fn request_extra_collects_stop_reasoning_and_session() {
        let extra = build_request_extra(Some(&vec!["END".into()]), Some("high"), Some("sess-1"));
        assert_eq!(extra["stop"], json!(["END"]));
        assert_eq!(extra["reasoning_effort"], "high");
        assert_eq!(extra["session_id"], "sess-1");
        // 全缺省 → 空对象(不破坏旧请求)。
        let empty = build_request_extra(None, None, None);
        assert_eq!(empty, json!({}));
        // 空白/空数组 → 不发射对应字段。
        let blanks = build_request_extra(Some(&vec![]), Some(""), Some(""));
        assert_eq!(blanks, json!({}));
    }

    #[test]
    fn chat_body_parses_stop_reasoning_effort_session_purpose() {
        let body: ChatBody = serde_json::from_value(json!({
            "model": "m",
            "messages": [],
            "stream": true,
            "stop": ["END"],
            "reasoning_effort": "low",
            "session_id": "s-1",
            "purpose": "compaction"
        }))
        .unwrap();
        assert_eq!(body.stop.as_deref(), Some(&["END".to_string()][..]));
        assert_eq!(body.reasoning_effort.as_deref(), Some("low"));
        assert_eq!(body.session_id.as_deref(), Some("s-1"));
        assert_eq!(body.purpose.as_deref(), Some("compaction"));
        // 旧客户端不带这些字段 → 全部 None。
        let legacy: ChatBody =
            serde_json::from_value(json!({"model": "m", "messages": []})).unwrap();
        assert!(
            legacy.stop.is_none()
                && legacy.reasoning_effort.is_none()
                && legacy.session_id.is_none()
                && legacy.purpose.is_none()
        );
    }

    #[tokio::test]
    async fn requests_returns_empty_or_records() {
        let (app, _dir) = test_app();
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/requests")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = to_bytes(resp.into_body(), 65536).await.unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert!(
            value["requests"].is_array(),
            "requests={}",
            value["requests"]
        );
    }

    #[test]
    fn request_log_serializes_to_json() {
        let log = RequestLog {
            id: "req-1".into(),
            model: "deepseek-v4-flash".into(),
            session_id: Some("sess-1".into()),
            purpose: Some("compaction".into()),
            stream: false,
            status: "ok".into(),
            finish_reason: Some("stop".into()),
            duration_ms: 42,
            usage: Some(json!({"completion_tokens": 7})),
            error: None,
            tools_count: 2,
        };
        let value = serde_json::to_value(&log).unwrap();
        assert_eq!(value["id"], "req-1");
        assert_eq!(value["model"], "deepseek-v4-flash");
        assert_eq!(value["session_id"], "sess-1");
        assert_eq!(value["purpose"], "compaction");
        assert_eq!(value["stream"], false);
        assert_eq!(value["status"], "ok");
        assert_eq!(value["finish_reason"], "stop");
        assert_eq!(value["duration_ms"], 42);
        assert_eq!(value["usage"]["completion_tokens"], 7);
        assert_eq!(value["tools_count"], 2);
        assert!(value["error"].is_null());
    }

    #[tokio::test]
    async fn health_returns_ok() {
        let (app, _dir) = test_app();
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = to_bytes(resp.into_body(), 4096).await.unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["ok"], true);
    }

    #[tokio::test]
    async fn switch_activates_default_profile() {
        let (app, _dir) = test_app();
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/switch")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"profile":"default"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = to_bytes(resp.into_body(), 4096).await.unwrap();
        let value: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["profile"]["id"], "default");
    }
}
