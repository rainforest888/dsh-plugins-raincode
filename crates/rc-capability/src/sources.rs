//! Multi-source scraping + parsing. Every parser is a pure function over
//! the fetched text so tests can run against saved fixtures.

use anyhow::{Context, Result};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

use crate::DEFAULT_PROXY;

const OPENROUTER_URL: &str = "https://openrouter.ai/api/v1/models";
const DEEPSWE_URL: &str = "https://deepswe.datacurve.ai/";
const OPENCODE_DATA_URL: &str = "https://opencode.ai/data";
const DEEPSEEK_README_URL: &str =
    "https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro/raw/main/README.md";

const USER_AGENT: &str = "raincode/0.1 (+capability refresh)";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct OpenRouterRow {
    pub id: String,
    pub intelligence_index: Option<f64>,
    pub coding_index: Option<f64>,
    pub agentic_index: Option<f64>,
    pub design_arena: HashMap<String, f64>,
    pub input_cost_per_m: Option<f64>,
    pub output_cost_per_m: Option<f64>,
    pub context_length: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DeepSweRow {
    pub model: String,
    pub reasoning_effort: String,
    pub pass_at_1: f64,
    pub mean_cost_usd: f64,
    pub mean_output_tokens: f64,
    pub mean_agent_steps: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct OfficialScores {
    pub hle: Option<f64>,
    pub hle_tools: Option<f64>,
    pub swe_verified: Option<f64>,
    pub swe_pro: Option<f64>,
    pub swe_multilingual: Option<f64>,
    pub imo_answer_bench: Option<f64>,
}

static PROXY_ONLY_HOSTS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn proxy_only_hosts() -> &'static Mutex<HashSet<String>> {
    PROXY_ONLY_HOSTS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn host_of(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| url.to_string())
}

/// 直连失败后走代理(默认 Clash),并记住该 host 下次直接走代理,
/// 避免 HF 这类站点每次先等 30s 直连超时。
async fn fetch_text(url: &str) -> Result<String> {
    let host = host_of(url);
    let skip_direct = proxy_only_hosts()
        .lock()
        .map(|g| g.contains(&host))
        .unwrap_or(false);
    if !skip_direct {
        let direct = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .user_agent(USER_AGENT)
            .build()?;
        if let Ok(resp) = direct.get(url).send().await {
            if resp.status().is_success() {
                return Ok(resp.text().await?);
            }
        }
        if let Ok(mut g) = proxy_only_hosts().lock() {
            g.insert(host.clone());
        }
    }
    let proxy = std::env::var("RAINCODE_HTTP_PROXY").unwrap_or_else(|_| DEFAULT_PROXY.to_string());
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent(USER_AGENT)
        .proxy(reqwest::Proxy::all(&proxy)?)
        .build()?;
    let resp = client.get(url).send().await?;
    let resp = resp.error_for_status()?;
    Ok(resp.text().await?)
}

pub fn bare_name(model_id: &str) -> String {
    let last = model_id.rsplit('/').next().unwrap_or(model_id);
    if let Some(dash) = last.rfind('-') {
        let suffix = &last[dash + 1..];
        if !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit() || c == '.') {
            return last[..dash].to_string();
        }
    }
    last.to_string()
}

pub async fn fetch_openrouter() -> Result<Vec<OpenRouterRow>> {
    let raw = fetch_text(OPENROUTER_URL).await?;
    parse_openrouter(&raw)
}

pub fn parse_openrouter(raw: &str) -> Result<Vec<OpenRouterRow>> {
    let value: serde_json::Value = serde_json::from_str(raw).context("OpenRouter JSON parse")?;
    let data = value
        .get("data")
        .and_then(|v| v.as_array())
        .context("OpenRouter data array missing")?;
    let mut out = Vec::new();
    for model in data {
        let Some(id) = model.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        let benchmarks = model.get("benchmarks").cloned().unwrap_or_default();
        let aa = benchmarks.get("artificial_analysis").cloned().unwrap_or_default();
        let mut design_arena = HashMap::new();
        if let Some(entries) = benchmarks.get("design_arena").and_then(|v| v.as_array()) {
            for e in entries {
                if let (Some(cat), Some(win)) = (
                    e.get("category").and_then(|v| v.as_str()),
                    e.get("win_rate").and_then(|v| v.as_f64()),
                ) {
                    design_arena.insert(cat.to_string(), win);
                }
            }
        }
        out.push(OpenRouterRow {
            id: id.to_string(),
            intelligence_index: aa.get("intelligence_index").and_then(|v| v.as_f64()),
            coding_index: aa.get("coding_index").and_then(|v| v.as_f64()),
            agentic_index: aa.get("agentic_index").and_then(|v| v.as_f64()),
            design_arena,
            input_cost_per_m: model
                .pointer("/pricing/prompt")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<f64>().ok())
                .map(|v| v * 1_000_000.0),
            output_cost_per_m: model
                .pointer("/pricing/completion")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<f64>().ok())
                .map(|v| v * 1_000_000.0),
            context_length: model.get("context_length").and_then(|v| v.as_u64()),
        });
    }
    Ok(out)
}

pub fn find_openrouter<'a>(rows: &'a [OpenRouterRow], model: &str) -> Option<&'a OpenRouterRow> {
    if let Some(row) = rows.iter().find(|r| bare_name(&r.id) == model) {
        return Some(row);
    }
    rows.iter().find(|r| {
        let bare = bare_name(&r.id);
        bare.starts_with(model) && bare[model.len()..].starts_with('-')
    })
}

pub async fn fetch_deepswe() -> Result<BTreeMap<String, DeepSweRow>> {
    let raw = fetch_text(DEEPSWE_URL).await?;
    parse_deepswe(&raw)
}

pub fn parse_deepswe(raw: &str) -> Result<BTreeMap<String, DeepSweRow>> {
    let re = Regex::new(
        r#"\$\w*\[[0-9]+\]=\{model:"([^"]+)",harness:"[^"]*",reasoning_effort:"([^"]+)",config:"[^"]*",source:"deep-swe",pass_rate:[0-9.eE+-]+,pass_at_1:([0-9.eE+-]+)"#,
    )?;
    let mut rows: BTreeMap<String, DeepSweRow> = BTreeMap::new();
    for caps in re.captures_iter(raw) {
        let model = caps[1].to_string();
        let effort = caps[2].to_string();
        let pass_at_1: f64 = caps[3].parse().unwrap_or(0.0);
        let after_start = caps.get(0).map(|m| m.end()).unwrap_or(0);
        let after = &raw[after_start..];
        let end = after.find('}').unwrap_or(after.len());
        let obj = &after[..end];
        let field = |name: &str| -> Option<f64> {
            obj.find(name)
                .and_then(|i| obj[i..].split_once(':').map(|s| s.1.to_string()))
                .and_then(|v| v.split(',').next().unwrap_or("").trim().parse::<f64>().ok())
        };
        let Some(mean_cost_usd) = field("mean_cost_usd") else {
            continue;
        };
        let Some(mean_output_tokens) = field("mean_output_tokens") else {
            continue;
        };
        let Some(mean_agent_steps) = field("mean_agent_steps") else {
            continue;
        };
        let better = match rows.get(&model) {
            Some(existing) => pass_at_1 > existing.pass_at_1,
            None => true,
        };
        if better {
            rows.insert(
                model.clone(),
                DeepSweRow {
                    model,
                    reasoning_effort: effort,
                    pass_at_1,
                    mean_cost_usd,
                    mean_output_tokens,
                    mean_agent_steps,
                },
            );
        }
    }
    Ok(rows)
}

pub async fn top_models_from_opencode() -> Result<Vec<String>> {
    let raw = fetch_text(OPENCODE_DATA_URL).await?;
    parse_opencode_top(&raw)
}

pub fn parse_opencode_top(raw: &str) -> Result<Vec<String>> {
    let re = Regex::new(
        r#"\{model:"([^"]+)",provider:"[^"]*",author:"[^"]*",tokens:[0-9]+,change:[^,]*?,\s*rank:([0-9]+)\}"#,
    )?;
    let mut rows: Vec<(u32, String)> = Vec::new();
    for caps in re.captures_iter(raw) {
        let rank: u32 = caps[2].parse().unwrap_or(u32::MAX);
        rows.push((rank, caps[1].to_string()));
    }
    rows.sort_by_key(|(rank, _)| *rank);
    let mut out = Vec::new();
    for (_, model) in rows {
        if !out.contains(&model) {
            out.push(model);
        }
    }
    if out.is_empty() {
        anyhow::bail!("opencode leaderboard rows not found");
    }
    Ok(out)
}

pub async fn fetch_official_deepseek() -> Result<HashMap<String, OfficialScores>> {
    let raw = fetch_text(DEEPSEEK_README_URL).await?;
    parse_deepseek_readme(&raw)
}

pub fn parse_deepseek_readme(markdown: &str) -> Result<HashMap<String, OfficialScores>> {
    let mut out = HashMap::new();
    let mut flash_col: Option<usize> = None;
    let mut pro_col: Option<usize> = None;
    for line in markdown.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with('|') {
            continue;
        }
        let cells: Vec<&str> = trimmed
            .trim_matches('|')
            .split('|')
            .map(|s| s.trim().trim_matches('*').trim())
            .collect();
        if cells.is_empty() {
            continue;
        }
        if cells[0].contains("Benchmark") && cells[0].contains("(Metric)") {
            let mut f = None;
            let mut p = None;
            for (i, cell) in cells.iter().enumerate() {
                if cell.contains("V4-Flash Max") {
                    f = Some(i);
                }
                if cell.contains("V4-Pro Max") {
                    p = Some(i);
                }
            }
            if f.is_some() || p.is_some() {
                flash_col = f;
                pro_col = p;
            }
            continue;
        }
        let (Some(fc), Some(pc)) = (flash_col, pro_col) else {
            continue;
        };
        let Some(metric) = cells.first() else {
            continue;
        };
        let benchmark = metric.trim().to_ascii_lowercase();
        let target = if benchmark.starts_with("hle w/ tools") {
            "hle_tools"
        } else if benchmark.starts_with("hle") {
            "hle"
        } else if benchmark.starts_with("swe verified") {
            "swe_verified"
        } else if benchmark.starts_with("swe pro") {
            "swe_pro"
        } else if benchmark.starts_with("swe multilingual") {
            "swe_multilingual"
        } else if benchmark.starts_with("imoanswerbench") {
            "imo_answer_bench"
        } else {
            continue;
        };
        for (model, kind) in [("deepseek-v4-flash", "flash"), ("deepseek-v4-pro", "pro")] {
            let value = cells.get(if kind == "flash" { fc } else { pc })
                .and_then(|v| v.parse::<f64>().ok());
            let Some(score) = value else { continue };
            let entry = out.entry(model.to_string()).or_insert_with(OfficialScores::default);
            match target {
                "hle" => entry.hle = Some(score),
                "hle_tools" => entry.hle_tools = Some(score),
                "swe_verified" => entry.swe_verified = Some(score),
                "swe_pro" => entry.swe_pro = Some(score),
                "swe_multilingual" => entry.swe_multilingual = Some(score),
                "imo_answer_bench" => entry.imo_answer_bench = Some(score),
                _ => {}
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_name_strips_provider_and_version() {
        assert_eq!(bare_name("deepseek/deepseek-v4-pro-0813"), "deepseek-v4-pro");
        assert_eq!(bare_name("qwen/qwen3.8-max"), "qwen3.8-max");
        assert_eq!(bare_name("deepseek/deepseek-v4-flash-latest"), "deepseek-v4-flash-latest");
    }

    #[test]
    fn parses_openrouter_fixture() {
        let raw = r#"{"data":[{"id":"deepseek/deepseek-v4-pro-0813","context_length":1048576,
        "pricing":{"prompt":"0.00000028","completion":"0.00000042"},
        "benchmarks":{"artificial_analysis":{"intelligence_index":53.2,"coding_index":68.8,"agentic_index":49.6},
        "design_arena":[{"arena":"models","category":"website","elo":1300,"win_rate":61.2,"rank":3}]}}]}"#;
        let rows = parse_openrouter(raw).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].input_cost_per_m, Some(0.28));
        assert_eq!(rows[0].design_arena.get("website"), Some(&61.2));
    }

    #[test]
    fn parses_deepswe_fixture() {
        let raw = r#"x $R[247]={model:"claude-opus-5",harness:"mini-swe-agent",reasoning_effort:"max",config:"c",source:"deep-swe",pass_rate:0.7364864864864865,pass_at_1:0.7364864864864865,pass_at_4:0.88,n_passed:327,mean_cost_usd:11.837583271396396,median_cost_usd:10.4,mean_output_tokens:117565.6936936937,median_output_tokens:113366.5,mean_input_tokens:15025834.39864865,mean_duration_seconds:1911.8,mean_agent_steps:99.0427927927928,median_agent_steps:90.5},$R[248]={model:"deepseek-v4-pro",harness:"mini-swe-agent",reasoning_effort:"max",config:"c2",source:"deep-swe",pass_rate:0.63,pass_at_1:0.63,pass_at_4:0.8,n_passed:300,mean_cost_usd:0.24,median_cost_usd:0.2,mean_output_tokens:106000.0,median_output_tokens:100000.0,mean_input_tokens:1000000.0,mean_duration_seconds:1000.0,mean_agent_steps:155.0,median_agent_steps:150.0}"#;
        let rows = parse_deepswe(raw).unwrap();
        assert_eq!(rows.len(), 2);
        let row = rows.get("deepseek-v4-pro").unwrap();
        assert!((row.pass_at_1 - 0.63).abs() < 1e-9);
        assert!((row.mean_cost_usd - 0.24).abs() < 1e-9);
    }

    #[test]
    fn parses_opencode_top_fixture() {
        let raw = r#"leaderboard:$R[1]=[$R[2]={model:"deepseek-v4-flash",provider:"deepseek",author:"DeepSeek",tokens:78097,change:64,rank:1},$R[3]={model:"qwen3.8-max",provider:"qwen",author:"Qwen",tokens:59,change:6,rank:2}],market:$R[4]"#;
        let top = parse_opencode_top(raw).unwrap();
        assert_eq!(top, vec!["deepseek-v4-flash", "qwen3.8-max"]);
    }

    #[test]
    fn parses_deepseek_readme_fixture() {
        let markdown = r#"| Benchmark (Metric) | V4-Flash Non-Think | V4-Flash Max | V4-Pro Non-Think | V4-Pro Max |
| HLE (Pass@1) | 8.1 | 34.8 | 7.7 | 37.7 |
| SWE Verified (Resolved) | 73.7 | 79.0 | 73.6 | 80.6 |
| HLE w/ tools (Pass@1) | - | 45.1 | - | 48.2 |
"#;
        let scores = parse_deepseek_readme(markdown).unwrap();
        assert_eq!(scores.get("deepseek-v4-pro").unwrap().hle, Some(37.7));
        assert_eq!(scores.get("deepseek-v4-flash").unwrap().swe_verified, Some(79.0));
        assert_eq!(scores.get("deepseek-v4-pro").unwrap().hle_tools, Some(48.2));
    }
}
