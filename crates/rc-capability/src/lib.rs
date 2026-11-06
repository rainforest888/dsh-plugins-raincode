//! Model capability refresh.
//!
//! Deterministic multi-source scraping (no LLM in the loop):
//! OpenRouter (AA indices + design-arena direction Elo/win-rate + pricing),
//! DeepSWE official leaderboard, opencode token-usage leaderboard, and
//! official model reports (currently DeepSeek HF README). Scores are
//! synthesized into a single [`CapabilityProfile`] and cached as JSON.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

mod scoring;
mod sources;

pub use scoring::{DirectionScores, Pricing};
pub use sources::{OpenRouterRow, top_models_from_opencode};

pub const DEFAULT_TOP_N: usize = 15;
pub const DEFAULT_PROXY: &str = "http://127.0.0.1:7890";

/// 每个 benchmark 的原始/归一化值,保留可审计性。0-100 百分比或 0-100 指数。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BenchmarkScores {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hle: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hle_tools: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub swe_verified: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub swe_pro: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub swe_multilingual: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub imo_answer_bench: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aa_intelligence_index: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aa_coding_index: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aa_agentic_index: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deepswe_pass1: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deepswe_avg_cost_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deepswe_avg_output_tokens: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deepswe_avg_steps: Option<f64>,
}

/// 方向能力,全部 0-1。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CapabilityScores {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub main: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coding: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agentic: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub knowledge: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub math: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub long_context: Option<f64>,
}

/// 性价比。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CostEfficiency {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coding_quality_per_dollar: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deepswe_score_per_dollar: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deepswe_score_per_output_token: Option<f64>,
}

/// 最终能力档案。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapabilityProfile {
    pub model: String,
    pub updated_at: String,
    pub pricing: Pricing,
    pub capability: CapabilityScores,
    pub directions: DirectionScores,
    pub benchmarks: BenchmarkScores,
    pub cost_efficiency: CostEfficiency,
    pub sources: Vec<String>,
    pub confidence: String,
}

/// 缓存文件:`~/.raincode/capabilities.json`。
pub fn capabilities_cache_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".raincode")
        .join("capabilities.json")
}

/// 保存一份档案;已有同名模型则替换。
pub fn save_profile(profile: &CapabilityProfile) -> Result<()> {
    let path = capabilities_cache_path();
    let mut all = load_profiles().unwrap_or_default();
    all.insert(profile.model.clone(), profile.clone());
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let text = serde_json::to_string_pretty(&all)?;
    std::fs::write(&path, text)?;
    Ok(())
}

/// 读取全部缓存档案。
pub fn load_profiles() -> Result<BTreeMap<String, CapabilityProfile>> {
    let path = capabilities_cache_path();
    if !path.exists() {
        return Ok(BTreeMap::new());
    }
    let text = std::fs::read_to_string(&path)?;
    let map = serde_json::from_str(&text).with_context(|| format!("bad cache {}", path.display()))?;
    Ok(map)
}

/// 单模型多源刷新 + 缓存。
pub async fn refresh_model(model: &str) -> Result<CapabilityProfile> {
    let model = model.trim().to_string();
    if model.is_empty() {
        anyhow::bail!("model must not be empty");
    }
    tracing::info!(model = %model, "raincode capability refresh start");

    let (openrouter, deepswe, official) = tokio::join!(
        sources::fetch_openrouter(),
        sources::fetch_deepswe(),
        sources::fetch_official_deepseek(),
    );
    // 每个源独立失败不阻断整体,只降低 confidence。
    let openrouter = match openrouter {
        Ok(v) => v,
        Err(e) => { tracing::warn!("openrouter source failed: {e}"); Vec::new() }
    };
    let deepswe = match deepswe {
        Ok(v) => v,
        Err(e) => { tracing::warn!("deepswe source failed: {e}"); BTreeMap::new() }
    };
    let official = match official {
        Ok(v) => v,
        Err(e) => { tracing::warn!("official-report source failed: {e}"); HashMap::new() }
    };

    let or_row = sources::find_openrouter(&openrouter, &model);
    let ds_row = deepswe.get(&model).cloned();
    let official_row = official.get(&model).cloned();
    let profile = scoring::synthesize(&model, or_row, ds_row.as_ref(), official_row.as_ref());
    save_profile(&profile)?;
    Ok(profile)
}

/// 刷新 opencode 调用量 top N。所有数据源只抓取一次,然后对每个模型综合,
/// 避免 N 个模型重复下载 OpenRouter/DeepSWE/官方报告。单模型失败不阻断。
pub async fn refresh_top_models(top: usize) -> Result<Vec<CapabilityProfile>> {
    let models = sources::top_models_from_opencode().await?;
    let (openrouter, deepswe, official) = tokio::join!(
        sources::fetch_openrouter(),
        sources::fetch_deepswe(),
        sources::fetch_official_deepseek(),
    );
    let openrouter = openrouter.unwrap_or_default();
    let deepswe = deepswe.unwrap_or_default();
    let official = official.unwrap_or_default();
    let mut out = Vec::new();
    for model in models.into_iter().take(top) {
        let or_row = sources::find_openrouter(&openrouter, &model);
        let ds_row = deepswe.get(&model).cloned();
        let official_row = official.get(&model).cloned();
        let profile = scoring::synthesize(&model, or_row, ds_row.as_ref(), official_row.as_ref());
        match save_profile(&profile) {
            Ok(()) => out.push(profile),
            Err(e) => tracing::warn!(model = %model, error = %e, "capability profile save failed"),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    #[test]
    fn cache_roundtrip() {
        let p = CapabilityProfile {
            model: "m".into(),
            updated_at: Utc::now().to_rfc3339(),
            pricing: Pricing::default(),
            capability: CapabilityScores::default(),
            directions: DirectionScores::default(),
            benchmarks: BenchmarkScores::default(),
            cost_efficiency: CostEfficiency::default(),
            sources: vec!["openrouter".into()],
            confidence: "low".into(),
        };
        save_profile(&p).unwrap();
        assert!(load_profiles().unwrap().contains_key("m"));
    }
}
