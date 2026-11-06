//! Raincode CLI: the terminal entry point for running, evolving, serving,
//! managing skills/profiles/MCP servers and acting as a CC-Switch-style
//! provider gateway.

use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use clap::{Parser, Subcommand};
use futures::StreamExt;
use rc_gateway::{serve as serve_gateway, GatewayConfig};
use rc_pro::{create_provider, Provider};
use rc_profile::cc_switch::{import_from_db, parse_deeplink, ProfileImport};
use rc_profile::model::{Profile, ProfileKind, Registry};
use rc_profile::writers::all_writers;
use rc_profile::{delete_key, find_provider, key_ref, protect_profile, store_key};
use rc_skill::source::{LocalSource, RemoteSource, SkillSource};
use rc_skill::{install_seed, seed_installed, Skill, SkillStore};
use rc_state::Store;
use serde::Deserialize;
use serde_json::json;
use tracing_subscriber::EnvFilter;


#[derive(Parser)]
#[command(
    name = "raincode",
    version,
    about = "Raincode headless gateway and configuration CLI"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// 交互式配置向导:选 provider → 填 API key → 测试连接 → 设默认模型。
    Setup,
    Skills {
        #[command(subcommand)]
        cmd: SkillsCmd,
    },
    Model {
        #[command(subcommand)]
        cmd: ModelCmd,
    },
    /// 管理缓存的模型能力画像(OpenRouter 真实榜单/定价)。
    Profiles {
        #[command(subcommand)]
        cmd: ProfilesCmd,
    },
    /// Start the CC-Switch-compatible HTTP gateway.
    Proxy {
        #[arg(long, default_value = "8787")]
        port: u16,
        /// Use an explicit registry file instead of the default profiles.toml.
        #[arg(long)]
        registry_path: Option<PathBuf>,
    },
}

#[derive(Subcommand)]
enum SkillsCmd {
    List,
    Show {
        name: String,
    },
    Create {
        name: String,
        category: String,
        description: String,
        #[arg(long)]
        body: Option<String>,
    },
    Edit {
        name: String,
        #[arg(long)]
        description: Option<String>,
        #[arg(long)]
        category: Option<String>,
        #[arg(long)]
        body: Option<String>,
    },
    Install {
        spec: String,
    },
    Update {
        spec: String,
    },
    Uninstall {
        name: String,
    },
    Search {
        query: String,
    },
    Review {
        name: Option<String>,
        #[arg(long)]
        approve: bool,
        #[arg(long)]
        reject: bool,
    },
    Stats,
    Graph,
}

#[derive(Subcommand)]
enum ModelCmd {
    List,
    /// List vendors in the one-key provider catalog.
    Catalog,
    Use {
        id: String,
        #[arg(long)]
        app: Option<String>,
    },
    Add {
        id: String,
        #[arg(long)]
        name: Option<String>,
        /// Provider catalog id: openai, anthropic, deepseek, kimi, qwen, gemini, zhipu, groq, openrouter, ollama.
        #[arg(long)]
        provider: Option<String>,
        #[arg(long)]
        kind: Option<String>,
        #[arg(long)]
        model: Option<String>,
        #[arg(long)]
        base_url: Option<String>,
        #[arg(long)]
        api_key: Option<String>,
        #[arg(long)]
        api_key_env: Option<String>,
        #[arg(long)]
        app: Option<String>,
        /// Skip connectivity check (useful for local endpoints / proxy issues).
        #[arg(long)]
        no_verify: bool,
    },
    /// Store or replace a profile's API key in the private key store.
    SetKey {
        id: String,
        #[arg(long)]
        api_key: Option<String>,
    },
    Remove {
        id: String,
    },
    Import {
        #[arg(long)]
        db: Option<String>,
        link: Option<String>,
    },
    Test {
        #[arg(long)]
        prompt: Option<String>,
    },
}

#[derive(Subcommand)]
enum ProfilesCmd {
    /// Show cached model capability profiles (model, context, pricing, multimodal).
    Show,
    /// Fetch model profiles from OpenRouter and normalize them into the state DB.
    Refresh,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct FileConfig {
    skills: SkillsSection,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default)]
struct SkillsSection {
    dir: Option<String>,
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env().add_directive("raincode=info".parse().unwrap()),
        )
        .try_init()
        .ok();
    let cli = Cli::parse();
    let runtime = tokio::runtime::Runtime::new().context("tokio runtime")?;
    match runtime.block_on(async_main(cli)) {
        Ok(()) => Ok(()),
        Err(e) => {
            eprintln!("[error] {e:#}");
            print_error_hint(&e);
            std::process::exit(1);
        }
    }
}

/// 根据错误内容给出可操作提示(I2 交互性)。
fn print_error_hint(err: &anyhow::Error) {
    let s = format!("{e:#}", e = err).to_lowercase();
    let hint = if s.contains("503") || s.contains("429") || s.contains("500") || s.contains("502")
        || s.contains("504") || s.contains("provider error") || s.contains("transport error")
    {
        "模型端点暂时不可用。稍后重试,或运行 `raincode model use <id>` 切换另一个模型。"
    } else if s.contains("no provider profiles") || s.contains("no active provider")
        || s.contains("no model configured") || s.contains("profiles configured")
        || s.contains("model add")
    {
        "还没有配置模型。运行 `raincode setup` 或 `raincode model add` 配置。"
    } else if s.contains("api key") || s.contains("401") || s.contains("403") || s.contains("auth")
        || s.contains("unauthorized") || s.contains("invalid key")
    {
        "API key 缺失或无效。运行 `raincode setup` 或 `raincode model set-key <id>` 重新配置。"
    } else if s.contains("compile") || s.contains("cargo check") || s.contains("error[") {
        "编译/检查失败,看上面 cargo 输出;修改后重试。"
    } else if s.contains("connect") || s.contains("network") || s.contains("timed out")
        || s.contains("timeout")
    {
        "网络连接问题。检查能否直连该 provider;外网可走 Clash 代理(127.0.0.1:7890)。"
    } else {
        "如反复失败:`raincode setup` 检查配置,或 `raincode model list` 查看模型。"
    };
    eprintln!("[hint] {hint}");
}

async fn async_main(cli: Cli) -> Result<()> {
    let config = load_config()?;
    match cli.command {
        Command::Setup => setup_command(&config).await,
        Command::Skills { cmd } => skills_command(&config, cmd).await,
        Command::Model { cmd } => model_command(&config, cmd).await,
        Command::Profiles { cmd } => profiles_command(&config, cmd).await,
        Command::Proxy { port, registry_path: explicit_registry } => {
            let addr = format!("127.0.0.1:{port}");
            let gateway_config = GatewayConfig {
                addr: addr.parse().context("invalid gateway address")?,
                registry_path: explicit_registry.unwrap_or_else(registry_path),
                // 复用 CLI 的 skills 目录解析(尊重 RAINCODE_HOME 与 config.skills.dir),
                // 与 rc_gateway::default_skills_dir() 的 ~/.raincode/skills 默认一致。
                skills_dir: skills_dir(&config),
                capability_weekly_refresh: true,
                capability_top_n: 15,
            };
            serve_gateway(gateway_config).await?;
            Ok(())
        }
    }
}

fn load_config() -> Result<FileConfig> {
    let path = config_path();
    if !path.exists() {
        return Ok(FileConfig::default());
    }
    let text = std::fs::read_to_string(&path).context("read config")?;
    toml::from_str(&text).context("parse config")
}

fn raincode_home() -> PathBuf {
    std::env::var_os("RAINCODE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".raincode")
        })
}

fn config_path() -> PathBuf {
    raincode_home().join("config.toml")
}

fn registry_path() -> PathBuf {
    raincode_home().join("profiles.toml")
}

fn state_path() -> PathBuf {
    raincode_home().join("state.db")
}

fn skills_dir(config: &FileConfig) -> PathBuf {
    let home = raincode_home().join("skills");
    config
        .skills
        .dir
        .as_deref()
        .map(expand_tilde)
        .unwrap_or(home)
}

fn expand_tilde(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(rest)
    } else {
        PathBuf::from(path)
    }
}

fn load_registry() -> Result<Registry> {
    let mut registry = Registry::load(registry_path())?;
    registry.ensure_default();
    let _ = registry.save(registry_path());
    Ok(registry)
}

fn save_registry(registry: &Registry) -> Result<()> {
    registry.save(registry_path())?;
    Ok(())
}

fn active_profile(registry: &Registry) -> Result<Profile> {
    registry
        .active()
        .cloned()
        .or_else(|| registry.profiles.first().cloned())
        .ok_or_else(|| anyhow!("no active provider profile; run `raincode model add`"))
}

/// 连通性自检:用 profile(含已解析 key)发一个最小 chat 请求,验证「选模型 →
/// 贴 key → 连上」闭环。成功返回描述消息,失败返回错误(不打印 key)。
async fn verify_provider_connectivity(profile: &Profile) -> Result<String> {
    use rc_pro::canonical::{CanonicalMessage, CanonicalRequest};
    use rc_pro::ProvEvent;
    use futures::StreamExt;

    let mut cfg = profile.to_provider_config();
    if cfg.api_key.is_none() {
        cfg.api_key = profile.resolved_api_key()?;
    }
    let provider = create_provider(cfg).map_err(|e| anyhow!("provider config: {e}"))?;
    let request = CanonicalRequest {
        model: profile.model.clone(),
        messages: vec![
            CanonicalMessage::system("You are a connectivity probe."),
            CanonicalMessage::user("Reply with exactly: ok"),
        ],
        tools: vec![],
        temperature: Some(0.0),
        max_tokens: Some(8),
        stream: true,
        extra: json!({}),
    };
    // 超时兜底:防止挂死的供应商阻塞向导。
    let timed = tokio::time::timeout(std::time::Duration::from_secs(20), async {
        let mut stream = provider.stream(request).await?;
        while let Some(ev) = stream.next().await {
            match ev.map_err(|e| anyhow!("provider error: {e}"))? {
                ProvEvent::Delta { .. } | ProvEvent::Finish { .. } => return Ok(()),
                ProvEvent::Error { message } => return Err(anyhow!("{message}")),
                _ => {}
            }
        }
        Ok(())
    })
    .await;
    match timed {
        Ok(Ok(())) => Ok(format!("✓ 连接成功:{} ({})", profile.model, profile.base_url)),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(anyhow!("连接超时(20s):{}", profile.base_url)),
    }
}

fn make_provider(registry: &Registry) -> Result<Arc<dyn Provider>> {
    provider_for_profile(registry, None)
}

fn provider_for_profile(registry: &Registry, id: Option<&str>) -> Result<Arc<dyn Provider>> {
    let profile = match id {
        Some(id) => registry
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!("provider profile '{id}' not found"))?,
        None => active_profile(registry)?,
    };
    let mut cfg = profile.to_provider_config();
    if cfg.api_key.is_none() {
        cfg.api_key = profile.resolved_api_key()?;
    }
    let provider = create_provider(cfg).map_err(|e| anyhow!("provider config: {e}"))?;
    Ok(Arc::from(provider))
}


fn ensure_seed(skills_dir: &Path) -> Result<()> {
    if !seed_installed(skills_dir) {
        let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let seed_root = repo_root.join("skills");
        if seed_root.exists() {
            install_seed(&seed_root, skills_dir)
                .map_err(|e| anyhow!("seed install failed: {e}"))?;
        }
    }
    Ok(())
}

fn sync_skill_index(store: &Store, skills: &SkillStore) -> Result<()> {
    for skill in skills.discover() {
        store
            .upsert_skill(&skill.to_row())
            .map_err(|e| anyhow!("skill index: {e}"))?;
    }
    Ok(())
}

async fn skills_command(config: &FileConfig, cmd: SkillsCmd) -> Result<()> {
    let skill_dir = skills_dir(config);
    ensure_seed(&skill_dir)?;
    let store = Store::open(state_path())?;
    let skills = SkillStore::new(&skill_dir);
    sync_skill_index(&store, &skills)?;
    match cmd {
        SkillsCmd::List => {
            for skill in skills.discover() {
                println!(
                    "{} ({}) conf={:.2} auto={}",
                    skill.name, skill.category, skill.confidence, skill.auto
                );
            }
        }
        SkillsCmd::Show { name } => match skills.load(&name) {
            Some(skill) => print!(
                "{}",
                skill.render().unwrap_or_else(|_| "render failed".into())
            ),
            None => return Err(anyhow!("skill '{name}' not found")),
        },
        SkillsCmd::Create {
            name,
            category,
            description,
            body,
        } => {
            if name.trim().is_empty() || category.trim().is_empty() {
                return Err(anyhow!("name and category are required"));
            }
            if skills.load(&name).is_some() {
                return Err(anyhow!("skill '{name}' already exists"));
            }
            let skill = Skill {
                name: name.clone(),
                description,
                short_description: None,
                category,
                path: PathBuf::new(),
                body: body
                    .unwrap_or_else(|| format!("# {name}\n\nWrite the reusable method here.\n")),
                relations: vec![],
                triggers: vec![],
                tags: vec![],
                version: 1,
                confidence: 0.5,
                usage_count: 0,
                success_rate: 0.0,
                last_used: None,
                auto: false,
                origin: "manual".into(),
                origin_url: None,
                scope: "user".into(),
                allow_implicit: true,
                embedding: None,
            };
            let path = skills.save(&skill).map_err(|e| anyhow!(e))?;
            sync_skill_index(&store, &skills)?;
            println!("created {}", path.display());
        }
        SkillsCmd::Edit {
            name,
            description,
            category,
            body,
        } => {
            let mut skill = skills
                .load(&name)
                .ok_or_else(|| anyhow!("skill '{name}' not found"))?;
            if let Some(description) = description {
                skill.description = description;
            }
            if let Some(category) = category {
                skill.category = category;
            }
            if let Some(body) = body {
                skill.body = body;
                skill.version += 1;
            }
            let path = skills.save(&skill).map_err(|e| anyhow!(e))?;
            sync_skill_index(&store, &skills)?;
            println!("updated {}", path.display());
        }
        SkillsCmd::Install { spec } => {
            let source: Box<dyn SkillSource> =
                if spec.starts_with("http") || spec.contains('/') && !Path::new(&spec).exists() {
                    Box::new(RemoteSource::new())
                } else {
                    Box::new(LocalSource::new(PathBuf::from(&spec)))
                };
            let report = source.install(&spec, &skill_dir).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            let store = Store::open(state_path())?;
            sync_skill_index(&store, &skills)?;
        }
        SkillsCmd::Update { spec } => {
            let source: Box<dyn SkillSource> =
                if spec.starts_with("http") || spec.contains('/') && !Path::new(&spec).exists() {
                    Box::new(RemoteSource::new())
                } else {
                    Box::new(LocalSource::new(PathBuf::from(&spec)))
                };
            let report = source.install(&spec, &skill_dir).await?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            sync_skill_index(&store, &skills)?;
        }
        SkillsCmd::Uninstall { name } => {
            skills.remove(&name).map_err(|e| anyhow!(e))?;
            store.delete_skill(&name)?;
            println!("removed {name}");
        }
        SkillsCmd::Search { query } => {
            let source = RemoteSource::new();
            for hit in source.search(&query).await {
                println!("{} | {} | {}", hit.name, hit.description, hit.url);
            }
        }
        SkillsCmd::Review {
            name,
            approve,
            reject,
        } => {
            if approve || reject {
                // 优先 review 隔离区(pending 确认的 auto skill)。
                let review_skill = name
                    .as_deref()
                    .and_then(|n| skills.discover_review().into_iter().find(|s| s.name == n));
                if let Some(skill) = review_skill {
                    let skill_name = skill.name.clone();
                    if reject {
                        skills.reject(&skill_name).map_err(|e| anyhow!(e))?;
                        store.delete_skill(&skill_name)?;
                        store.add_audit("skills.review.reject", &format!("rejected {skill_name}"), "user")?;
                        println!("rejected {skill_name}");
                    } else {
                        let path = skills.approve(&skill_name).map_err(|e| anyhow!(e))?;
                        // load 可能为 None(approve 成功但加载失败):报错而非 panic。
                        let Some(loaded) = skills.load(&skill_name) else {
                            println!("failed to load {skill_name} after approve");
                            return Ok(());
                        };
                        store.upsert_skill(&loaded.to_row())?;
                        store.add_audit(
                            "skills.review.approve",
                            &format!("approved {} at {}", skill_name, path.display()),
                            "user",
                        )?;
                        println!("approved {}", path.display());
                    }
                    return Ok(());
                }
                // 回退:review 已有 skill 的 approve/reject(转正 auto skill)。
                let skill = skills.load(name.as_deref().unwrap_or("")).ok_or_else(|| {
                    anyhow!("skill '{}' not found", name.as_deref().unwrap_or(""))
                })?;
                if reject {
                    let name = skill.name.clone();
                    skills.remove(&name).map_err(|e| anyhow!(e))?;
                    store.delete_skill(&name)?;
                    store.add_audit("skills.review.reject", &format!("rejected {name}"), "user")?;
                    println!("rejected {name}");
                } else {
                    let mut approved = skill;
                    approved.auto = false;
                    approved.confidence = approved.confidence.max(0.7);
                    let path = skills.save(&approved).map_err(|e| anyhow!(e))?;
                    store.upsert_skill(&approved.to_row())?;
                    store.add_audit(
                        "skills.review.approve",
                        &format!("approved {} at {}", approved.name, path.display()),
                        "user",
                    )?;
                    println!("approved {}", path.display());
                }
            } else {
                // 列出待确认的 review 区 skill(优先)+ 已有 auto skill。
                let mut listed = false;
                for skill in skills.discover_review() {
                    println!(
                        "[PENDING] {} ({}) conf={:.2} origin={} — run `skills review {} --approve|--reject`",
                        skill.name, skill.category, skill.confidence, skill.origin, skill.name
                    );
                    listed = true;
                }
                for skill in skills.discover().into_iter().filter(|s| s.auto) {
                    println!(
                        "[AUTO] {} ({}) conf={:.2} origin={}",
                        skill.name, skill.category, skill.confidence, skill.origin
                    );
                }
                if !listed {
                    let _ = listed;
                }
            }
        }
        SkillsCmd::Stats => {
            let all = skills.discover();
            println!(
                "total={} auto={} seed={}",
                all.len(),
                all.iter().filter(|s| s.auto).count(),
                all.iter().filter(|s| s.origin == "seed").count()
            );
        }
        SkillsCmd::Graph => {
            let all = skills.discover();
            if let Err(msg) = rc_skill::validate_dag(&all) {
                eprintln!("warning: {msg}");
            }
            for skill in all {
                for rel in &skill.relations {
                    println!("{} --{}--> {}", skill.name, rel.kind.as_str(), rel.skill);
                }
            }
        }
    }
    Ok(())
}

/// 交互式读取一行输入(带提示,不回显限制;key 走单独流程)。
fn prompt_line(prompt: &str) -> String {
    print!("{prompt}");
    io::stdout().flush().ok();
    let mut line = String::new();
    io::stdin().lock().read_line(&mut line).ok();
    line.trim().to_string()
}

/// `raincode setup` 交互式配置向导:添加模型 → 填 key → 验证 → 设默认。
async fn setup_command(_config: &FileConfig) -> Result<()> {
    let mut registry = load_registry()?;
    println!("== Raincode 配置向导 ==");
    loop {
        if registry.profiles.is_empty() {
            println!("当前还没有配置任何模型。先添加一个 provider。");
        } else {
            println!("\n已配置模型池:");
            for (i, p) in registry.profiles.iter().enumerate() {
                let active = registry.active_id.as_deref() == Some(p.id.as_str());
                let mark = if active { "*" } else { " " };
                println!("  {}. {}{}  {}  {}", i + 1, mark, p.id, p.model, p.base_url);
            }
            println!("(* 为默认模型)");
        }
        let menu = if registry.profiles.is_empty() {
            "1. 添加模型   q. 退出"
        } else {
            "1. 添加模型  2. 设为默认  3. 测试连接  4. 移除   q. 退出"
        };
        println!("\n{menu}");
        let choice = prompt_line("> ").trim().to_lowercase();
        match choice.as_str() {
            "1" => add_provider_wizard(&mut registry).await?,
            "2" if !registry.profiles.is_empty() => set_active_wizard(&registry)?,
            "3" if !registry.profiles.is_empty() => test_connection_wizard(&registry).await?,
            "4" if !registry.profiles.is_empty() => remove_profile_wizard(&mut registry)?,
            "q" | "" => {
                println!("\n配置完成。开始干活:");
                println!("  raincode run \"写个函数并测试\"     单次任务");
                println!("  raincode route \"复杂任务\"          多模型拆解执行");
                println!("  raincode profiles enrich          自动拉真实定价/评分刷新模型池");
                break;
            }
            _ => println!("无效选择,重试。"),
        }
    }
    Ok(())
}

/// 添加 provider:从 catalog 选供应商 → 模型 → API key → 验证 → 保存并设默认。
async fn add_provider_wizard(registry: &mut Registry) -> Result<()> {
    let entries = rc_profile::catalog::catalog();
    println!("\n选择供应商:");
    for (i, e) in entries.iter().enumerate() {
        println!(
            "  {}. {}  (默认模型 {})",
            i + 1,
            e.display_name,
            e.default_model
        );
    }
    let choice = prompt_line("编号 (q=取消): ").trim().to_string();
    if choice.eq_ignore_ascii_case("q") || choice.is_empty() {
        return Ok(());
    }
    let idx: usize = match choice.parse::<usize>() {
        Ok(n) if n >= 1 && n <= entries.len() => n - 1,
        _ => {
            println!("无效编号。");
            return Ok(());
        }
    };
    let entry = &entries[idx];
    // id 冲突时加序号(如 openai-2)。
    let mut id = entry.id.to_string();
    if registry.get(&id).is_some() {
        let mut n = 2;
        while registry.get(&format!("{id}-{n}")).is_some() {
            n += 1;
        }
        id = format!("{id}-{n}");
    }
    let model = prompt_line(&format!("模型名 (回车用默认 {}): ", entry.default_model))
        .trim()
        .to_string();
    let model = if model.is_empty() {
        entry.default_model.to_string()
    } else {
        model
    };
    let key = prompt_line("API key (粘贴后回车;留空则用环境变量): ").trim().to_string();
    if key.is_empty() {
        println!(
            "未填 key,将尝试环境变量 {}。",
            entry.env_var.unwrap_or("<无>")
        );
    }

    let mut profile = Profile {
        id: id.clone(),
        name: format!("{} ({})", entry.display_name, id),
        app: "raincode".into(),
        kind: entry.kind,
        base_url: entry.base_url.to_string(),
        model: model.clone(),
        api_key: None,
        api_key_env: entry.env_var.map(|e| e.to_string()),
        api_key_file: None,
        embedding_model: entry.embedding_model.map(|e| e.to_string()),
        headers: Default::default(),
        extra: serde_json::json!({}),
    };
    // 连通性验证(非本地 + 有 key):通过才落盘。
    let is_local = matches!(entry.kind, ProfileKind::Ollama)
        || entry.base_url.contains("localhost")
        || entry.base_url.contains("127.0.0.1");
    if !is_local && !key.is_empty() {
        let mut probe = profile.clone();
        probe.api_key = Some(key.clone());
        match verify_provider_connectivity(&probe).await {
            Ok(msg) => println!("{msg}"),
            Err(e) => {
                eprintln!("[verify] 连接失败: {e}");
                let cont = prompt_line("[verify] 若确定 key 无误仍要保存,输入 y: ").trim().to_lowercase();
                if cont != "y" {
                    return Ok(());
                }
            }
        }
    }
    if !key.is_empty() {
        store_key(&id, &key)?;
        profile.api_key = None;
        profile.api_key_file = Some(key_ref(&id));
    }
    registry.add(profile);
    registry.set_active(&id)?;
    save_registry(registry)?;
    println!("已添加并设为默认: {id} ({model})");
    Ok(())
}

/// 从已配置 profile 里选一个设为默认。
fn set_active_wizard(registry: &Registry) -> Result<()> {
    println!("\n选择要设为默认的模型:");
    for (i, p) in registry.profiles.iter().enumerate() {
        let active = registry.active_id.as_deref() == Some(p.id.as_str());
        println!("  {}. {}{}  {}", i + 1, if active { "*" } else { " " }, p.id, p.model);
    }
    let choice = prompt_line("编号 (q=取消): ").trim().to_string();
    if choice.eq_ignore_ascii_case("q") || choice.is_empty() {
        return Ok(());
    }
    match choice.parse::<usize>() {
        Ok(n) if n >= 1 && n <= registry.profiles.len() => {
            let id = registry.profiles[n - 1].id.clone();
            let mut r = load_registry()?;
            r.set_active(&id)?;
            save_registry(&r)?;
            println!("默认模型已设为: {id}");
        }
        _ => println!("无效编号。"),
    }
    Ok(())
}

/// 选一个 profile 测试连通性。
async fn test_connection_wizard(registry: &Registry) -> Result<()> {
    println!("\n选择要测试的模型:");
    for (i, p) in registry.profiles.iter().enumerate() {
        println!("  {}. {}  {}", i + 1, p.id, p.model);
    }
    let choice = prompt_line("编号 (q=取消): ").trim().to_string();
    if choice.eq_ignore_ascii_case("q") || choice.is_empty() {
        return Ok(());
    }
    match choice.parse::<usize>() {
        Ok(n) if n >= 1 && n <= registry.profiles.len() => {
            let profile = registry.profiles[n - 1].clone();
            match verify_provider_connectivity(&profile).await {
                Ok(msg) => println!("{msg}"),
                Err(e) => eprintln!("[verify] 连接失败: {e}"),
            }
        }
        _ => println!("无效编号。"),
    }
    Ok(())
}

/// 移除一个 profile(含 key)。
fn remove_profile_wizard(registry: &mut Registry) -> Result<()> {
    println!("\n选择要移除的模型:");
    for (i, p) in registry.profiles.iter().enumerate() {
        println!("  {}. {}  {}", i + 1, p.id, p.model);
    }
    let choice = prompt_line("编号 (q=取消): ").trim().to_string();
    if choice.eq_ignore_ascii_case("q") || choice.is_empty() {
        return Ok(());
    }
    match choice.parse::<usize>() {
        Ok(n) if n >= 1 && n <= registry.profiles.len() => {
            let id = registry.profiles[n - 1].id.clone();
            registry.remove(&id);
            delete_key(&id)?;
            save_registry(registry)?;
            println!("已移除: {id}");
        }
        _ => println!("无效编号。"),
    }
    Ok(())
}

async fn model_command(_config: &FileConfig, cmd: ModelCmd) -> Result<()> {
    let mut registry = load_registry()?;
    match cmd {
        ModelCmd::List => {
            for profile in &registry.profiles {
                let active = registry.active_id.as_deref() == Some(profile.id.as_str());
                let key = if profile.api_key_file.is_some() {
                    " key=file"
                } else if profile.api_key_env.is_some() {
                    " key=env"
                } else if profile.api_key.is_some() {
                    " key=inline"
                } else {
                    ""
                };
                println!(
                    "{}{} | {} | {}{} | {}",
                    if active { "* " } else { "  " },
                    profile.id,
                    profile.kind.as_str(),
                    profile.model,
                    key,
                    profile.base_url
                );
            }
        }
        ModelCmd::Catalog => {
            for entry in rc_profile::catalog::catalog() {
                println!(
                    "{:<12} {:<28} {} | env: {}",
                    entry.id,
                    entry.display_name,
                    entry.default_model,
                    entry.env_var.unwrap_or("-")
                );
            }
        }
        ModelCmd::Use { id, app } => {
            registry.set_active(&id)?;
            save_registry(&registry)?;
            if let Some(app_name) = app {
                let profile = active_profile(&registry)?;
                for writer in all_writers() {
                    if writer.app() == app_name {
                        writer.apply(&profile)?;
                        println!("wrote {} config", app_name);
                    }
                }
            }
            println!("active profile: {id}");
        }
        ModelCmd::Add {
            id,
            name,
            provider,
            kind,
            model,
            base_url,
            api_key,
            api_key_env,
            app,
            no_verify,
        } => {
            let mut profile = if let Some(provider_id) = provider {
                let entry = find_provider(&provider_id)
                    .ok_or_else(|| anyhow!("unknown provider '{provider_id}'"))?;
                Profile {
                    id: id.clone(),
                    name: name.unwrap_or_else(|| format!("{} ({})", entry.display_name, id)),
                    app: app.unwrap_or_else(|| "raincode".into()),
                    kind: entry.kind,
                    base_url: base_url.unwrap_or_else(|| entry.base_url.to_string()),
                    model: model.unwrap_or_else(|| entry.default_model.to_string()),
                    api_key: None,
                    api_key_env: api_key_env.or_else(|| entry.env_var.map(str::to_string)),
                    api_key_file: None,
                    embedding_model: entry.embedding_model.map(str::to_string),
                    headers: Default::default(),
                    extra: json!({}),
                }
            } else {
                Profile {
                    id: id.clone(),
                    name: name.unwrap_or_else(|| id.clone()),
                    app: app.unwrap_or_else(|| "raincode".into()),
                    kind: ProfileKind::from_str(kind.as_deref().unwrap_or("openai-compat")),
                    base_url: base_url.unwrap_or_default(),
                    model: model.unwrap_or_else(|| "gpt-4o-mini".to_string()),
                    api_key: None,
                    api_key_env,
                    api_key_file: None,
                    embedding_model: None,
                    headers: Default::default(),
                    extra: json!({}),
                }
            };
            // 连通性自检:非本地供应商、且用户提供了 key 时,先验证再保存。
            // 本地(ollama/lmstudio/vllm)无 key,跳过;用户明确 --no-verify 才跳过。
            let is_local = matches!(profile.kind, ProfileKind::Ollama)
                || profile.base_url.contains("localhost")
                || profile.base_url.contains("127.0.0.1");
            let verify = !no_verify && !is_local && api_key.is_some();
            if verify {
                // 先用临时 profile(key 注入内存)验证,通过后才真正写 key 文件 + 保存。
                let mut probe = profile.clone();
                if let Some(key) = &api_key {
                    probe.api_key = Some(key.clone());
                }
                match verify_provider_connectivity(&probe).await {
                    Ok(msg) => println!("{msg}"),
                    Err(e) => {
                        // 验证失败:不保存,提示重试或 --no-verify 跳过。
                        eprintln!("[verify] 连接失败,未保存: {e}");
                        eprintln!("[verify] 若确定 key 无误,可用 --no-verify 跳过检查");
                        return Ok(());
                    }
                }
            }
            if let Some(key) = api_key {
                store_key(&id, &key)?;
                profile.api_key = None;
                profile.api_key_file = Some(key_ref(&id));
            }
            registry.add(profile);
            save_registry(&registry)?;
            println!("added profile {id}");
        }
        ModelCmd::SetKey { id, api_key } => {
            let key = match api_key {
                Some(key) => key,
                None => {
                    let mut line = String::new();
                    print!("Paste API key: ");
                    io::stdout().flush().ok();
                    io::stdin().lock().read_line(&mut line).ok();
                    line.trim().to_string()
                }
            };
            store_key(&id, &key)?;
            if let Some(profile) = registry.get_mut(&id) {
                profile.api_key = None;
                profile.api_key_file = Some(key_ref(&id));
            } else {
                return Err(anyhow!("profile '{id}' not found"));
            }
            save_registry(&registry)?;
            println!("stored key for {id}");
        }
        ModelCmd::Remove { id } => {
            registry.remove(&id);
            delete_key(&id)?;
            save_registry(&registry)?;
            println!("removed profile {id}");
        }
        ModelCmd::Import { db, link } => {
            let imports: Vec<ProfileImport> = if let Some(link) = link {
                parse_deeplink(&link).into_iter().collect()
            } else {
                let db_path = db.unwrap_or_else(|| {
                    dirs::home_dir()
                        .unwrap_or_else(|| PathBuf::from("."))
                        .join(".cc-switch")
                        .join("cc-switch.db")
                        .to_string_lossy()
                        .to_string()
                });
                import_from_db(PathBuf::from(db_path))?
            };
            if imports.is_empty() {
                return Err(anyhow!("no profiles imported"));
            }
            for imported in &imports {
                let id = slugify(&imported.name);
                let mut profile = imported.to_profile(id);
                protect_profile(&mut profile)?;
                registry.add(profile);
            }
            save_registry(&registry)?;
            println!("imported {} profiles", imports.len());
        }
        ModelCmd::Test { prompt } => {
            let prompt = prompt.unwrap_or_else(|| "Say hello in one sentence.".to_string());
            let provider = make_provider(&registry)?;
            let req = rc_pro::CanonicalRequest {
                model: provider.id().to_string(),
                messages: vec![rc_pro::CanonicalMessage::user(prompt)],
                tools: vec![],
                temperature: Some(0.2),
                max_tokens: Some(200),
                stream: true,
                extra: json!({}),
            };
            let mut stream = provider.stream(req).await?;
            while let Some(event) = stream.next().await {
                if let rc_pro::ProvEvent::Delta { text } = event? {
                    print!("{text}");
                    io::stdout().flush().ok();
                }
            }
            println!();
        }
    }
    Ok(())
}

/// OpenRouter `/api/v1/models` entry (fields we care about; the rest is ignored).
#[derive(Debug, Deserialize)]
struct OpenRouterModel {
    id: String,
    #[serde(rename = "context_length", default)]
    context_length: u64,
    #[serde(default)]
    pricing: OpenRouterPricing,
    #[serde(default)]
    benchmarks: OpenRouterBenchmarks,
}

#[derive(Debug, Deserialize, Default)]
struct OpenRouterPricing {
    #[serde(default)]
    prompt: String,
    #[serde(default)]
    completion: String,
}

/// OpenRouter 模型的公开榜单分(真实数据,非编造):
/// `artificial_analysis`(Artificial Analysis 0-100 指数)与 `design_arena`(LMArena Elo)。
#[derive(Debug, Deserialize, Default)]
struct OpenRouterBenchmarks {
    #[serde(default)]
    artificial_analysis: Option<ArtificialAnalysis>,
    #[serde(default)]
    design_arena: Option<Vec<DesignArenaEntry>>,
}

#[derive(Debug, Deserialize, Clone, Default)]
struct ArtificialAnalysis {
    #[serde(default)]
    intelligence_index: Option<f64>,
    #[serde(default)]
    coding_index: Option<f64>,
}

#[derive(Debug, Deserialize, Clone, Default)]
struct DesignArenaEntry {
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    elo: Option<f64>,
}

/// 解析 OpenRouter /api/v1/models 的 data 数组 → CapabilityProfileRow
/// (能力分暂用种子同名回退,定价/窗口取真实值)。
pub(crate) fn parse_openrouter_models(raw: &str) -> Result<Vec<rc_state::CapabilityProfileRow>, serde_json::Error> {
    #[derive(Deserialize)]
    struct Wrapper {
        data: Vec<OpenRouterModel>,
    }
    let w: Wrapper = serde_json::from_str(raw)?;
    Ok(w.data
        .into_iter()
        .map(|m| {
            let inp = m.pricing.prompt.parse::<f64>().unwrap_or(0.0) * 1_000_000.0;
            let outp = m.pricing.completion.parse::<f64>().unwrap_or(0.0) * 1_000_000.0;
            // context_length 缺省/为 0 时用默认窗口兜底,不让刷新整体失败。
            let context = if m.context_length == 0 { 128_000 } else { m.context_length as u32 };
            // 真实榜单分(非编造):artificial_analysis 指数直接是 0-100;design_arena
            // 是 Elo(~1000-1400),归一化到 0-100。缺失的维度=0(诚实:无公开数据)。
            let aa = m.benchmarks.artificial_analysis.clone().unwrap_or_default();
            let reasoning = aa.intelligence_index.unwrap_or(0.0);
            let coding = aa.coding_index.unwrap_or(0.0);
            let math = aa.intelligence_index.unwrap_or(0.0); // 无独立 math 榜单,用 intelligence 代理
            let da = m.benchmarks.design_arena.clone().unwrap_or_default();
            let elo = |cat: &str| da.iter()
                .find(|e| e.category.as_deref() == Some(cat))
                .and_then(|e| e.elo)
                .map(normalize_arena_elo)
                .unwrap_or(0.0);
            let frontend = elo("website");
            let backend = elo("codecategories");
            // long_context:由真实 context_length 归一化(128k 起步,1M 满分)。
            let long_context = ((context as f64 / 128_000.0).min(1.0) * 100.0).max(0.0);
            let has_benchmarks = aa.intelligence_index.is_some() || !da.is_empty();
            rc_state::CapabilityProfileRow {
                model: m.id,
                reasoning,
                coding,
                frontend,
                backend,
                math,
                long_context,
                input_cost_per_m: inp.max(0.0001),
                output_cost_per_m: outp.max(0.0001),
                context_window: context,
                source: if has_benchmarks { "openrouter-arena".into() } else { "openrouter".into() },
                updated_at: "now".into(),
                multimodal: false,
            }
        })
        .collect())
}

/// LMArena Elo(~1000-1400)→ 0-100:1000≈0 分,1400≈100 分。
fn normalize_arena_elo(elo: f64) -> f64 {
    ((elo - 1000.0) / 400.0 * 100.0).clamp(0.0, 100.0)
}

async fn profiles_command(_config: &FileConfig, cmd: ProfilesCmd) -> Result<()> {
    let store = Store::open(state_path())?;
    match cmd {
        ProfilesCmd::Show => {
            let rows = store.all_model_profiles()?;
            for r in &rows {
                println!(
                    "{} · ctx {} · in {} out {} · multimodal {}",
                    r.model, r.context_window, r.input_cost_per_m, r.output_cost_per_m, r.multimodal
                );
            }
            Ok(())
        }
        ProfilesCmd::Refresh => {
            let n = refresh_profiles(&store).await?;
            println!("refreshed {n} models");
            Ok(())
        }
    }
}

/// 从 OpenRouter 拉取模型列表 + 公开榜单分并入库,返回写入的模型数。
/// 供 CLI `profiles refresh` 与 REPL `/refresh` 命令共用。
pub async fn refresh_profiles(store: &Store) -> Result<usize> {
    // /api/v1/models 是公开接口,key 可选(有 key 时带上防限流,不落库、不打印)。
    let key = std::fs::read_to_string(rc_profile::secrets::key_path("openrouter"))
        .unwrap_or_default()
        .trim()
        .to_string();
    let url = "https://openrouter.ai/api/v1/models";
    let client = reqwest::Client::new();
    let mut req = client.get(url);
    if !key.is_empty() {
        req = req.header("Authorization", format!("Bearer {key}"));
    }
    let resp = req.send().await?;
    // 显式检查 HTTP 状态:非 2xx 立即报错,而不是带着错误 body 往下解析。
    let resp = resp.error_for_status()?;
    let raw = resp.text().await?;
    let rows = parse_openrouter_models(&raw)?;
    for r in &rows {
        store.upsert_model_profile(r)?;
    }
    Ok(rows.len())
}

fn slugify(input: &str) -> String {
    let mut out = String::new();
    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            out.push(ch);
        } else if ch.is_whitespace() {
            out.push('-');
        }
    }
    let out = out.trim_matches('-').to_string();
    if out.is_empty() {
        "imported".to_string()
    } else {
        out.to_lowercase()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // OpenRouter /api/v1/models 返回格式的真实子集(fixture)。
    const OPENROUTER_FIXTURE: &str = r#"{
      "data": [
        {
          "id": "deepseek/deepseek-chat",
          "context_length": 128000,
          "pricing": {"prompt": "0.00000014", "completion": "0.00000028"}
        },
        {
          "id": "qwen/qwen2.5-coder-32b-instruct",
          "context_length": 32768,
          "pricing": {"prompt": "0.2", "completion": "0.6"}
        },
        {
          "id": "meta-llama/llama-3.3-70b-instruct",
          "context_length": 131072
        }
      ]
    }"#;

    #[test]
    fn parse_openrouter_models_extracts_pricing_and_context() {
        let rows = parse_openrouter_models(OPENROUTER_FIXTURE).unwrap();
        assert_eq!(rows.len(), 3);
        let first = &rows[0];
        assert_eq!(first.model, "deepseek/deepseek-chat");
        assert_eq!(first.context_window, 128_000);
        // 0.00000014 $/token × 1e6 = $0.14/M.
        assert!((first.input_cost_per_m - 0.14).abs() < 1e-9);
        assert!((first.output_cost_per_m - 0.28).abs() < 1e-9);
        assert_eq!(first.source, "openrouter");
        assert_eq!(first.updated_at, "now");
        assert!(!first.multimodal);
        // 第二个:无榜单数据 → 能力分诚实为 0(不再是 seed 中位 70)。
        assert_eq!(rows[1].model, "qwen/qwen2.5-coder-32b-instruct");
        assert!((rows[1].reasoning - 0.0).abs() < 1e-9);
        assert_eq!(rows[1].source, "openrouter");
        // 第三个:pricing 缺省 → 0.0 → max(0.0001) 兜底
        let third = &rows[2];
        assert_eq!(third.context_window, 131_072);
        assert!((third.input_cost_per_m - 0.0001).abs() < 1e-9);
        assert!((third.output_cost_per_m - 0.0001).abs() < 1e-9);
    }

    #[test]
    fn parse_openrouter_models_scales_per_token_to_per_million() {
        // OpenRouter pricing is $/token; the DB stores $/1M tokens. deepseek 0.00000008/token
        // = $0.08/M, output 0.00000018/token = $0.18/M.
        let raw = r#"{"data":[{"id":"deepseek/deepseek-v4-flash-0731","context_length":1048576,
            "pricing":{"prompt":"0.00000008","completion":"0.00000018"},
            "benchmarks":{},"description":"x"}]}"#;
        let rows = parse_openrouter_models(raw).unwrap();
        assert_eq!(rows[0].input_cost_per_m, 0.08);
        assert_eq!(rows[0].output_cost_per_m, 0.18);
    }

    #[test]
    fn parse_openrouter_models_extracts_real_arena_scores() {
        // 带 benchmarks 的模型:artificial_analysis(0-100)与 design_arena(Elo)映射。
        let raw = r#"{
          "data": [
            {
              "id": "deepseek/deepseek-v4-flash-0731",
              "context_length": 1048576,
              "pricing": {"prompt": "0.1", "completion": "0.3"},
              "benchmarks": {
                "artificial_analysis": {"intelligence_index": 51.8, "coding_index": 69.1, "agentic_index": 48.4},
                "design_arena": [
                  {"category": "website", "elo": 1230.0},
                  {"category": "codecategories", "elo": 1233.0}
                ]
              }
            }
          ]
        }"#;
        let rows = parse_openrouter_models(raw).unwrap();
        let p = &rows[0];
        // Artificial Analysis 指数直接用。
        assert!((p.reasoning - 51.8).abs() < 1e-9);
        assert!((p.coding - 69.1).abs() < 1e-9);
        assert!((p.math - 51.8).abs() < 1e-9);
        // design_arena Elo 归一化:website=1230 → (1230-1000)/400*100 = 57.5;codecategories=1233 → 58.25。
        assert!((p.frontend - 57.5).abs() < 1e-9);
        assert!((p.backend - 58.25).abs() < 1e-9);
        // long_context:1M ctx → 100。
        assert!((p.long_context - 100.0).abs() < 1e-9);
        assert_eq!(p.source, "openrouter-arena");
        assert_eq!(p.context_window, 1_048_576);
    }

    #[test]
    fn parse_openrouter_models_rejects_malformed_json() {
        assert!(parse_openrouter_models("not json").is_err());
    }
}
