//! Score synthesis: raw multi-source rows → capability/directions/cost efficiency.

use serde::{Deserialize, Serialize};

use super::{BenchmarkScores, CapabilityProfile, CapabilityScores, CostEfficiency};
use crate::sources::{DeepSweRow, OfficialScores, OpenRouterRow};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Pricing {
    pub input_cost_per_m: Option<f64>,
    pub output_cost_per_m: Option<f64>,
    pub context_length: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DirectionScores {
    pub frontend: Option<f64>,
    pub backend: Option<f64>,
    pub fullstack: Option<f64>,
    pub mobile: Option<f64>,
    pub game: Option<f64>,
    pub data: Option<f64>,
    pub design: Option<f64>,
    pub cli: Option<f64>,
}

fn clamp01(x: f64) -> f64 {
    x.clamp(0.0, 1.0)
}

/// 百分比/指数 → 0-1。
fn norm_pct(v: Option<f64>) -> Option<f64> {
    v.map(|x| clamp01(x / 100.0))
}

fn mean(parts: &[Option<f64>]) -> Option<f64> {
    let vals: Vec<f64> = parts.iter().flatten().copied().collect();
    if vals.is_empty() {
        None
    } else {
        Some(vals.iter().sum::<f64>() / vals.len() as f64)
    }
}

/// 按可用值加权平均;权重与 values 等长,自动按保留项重归一化。
fn weighted_available(values: &[Option<f64>], weights: &[f64]) -> Option<f64> {
    let mut sum = 0.0;
    let mut weight_sum = 0.0;
    for (v, w) in values.iter().zip(weights) {
        if let Some(v) = v {
            sum += v * w;
            weight_sum += w;
        }
    }
    if weight_sum > 0.0 {
        Some(sum / weight_sum)
    } else {
        None
    }
}

fn arena(or: Option<&OpenRouterRow>, cats: &[&str]) -> Option<f64> {
    let or = or?;
    let vals: Vec<Option<f64>> = cats
        .iter()
        .map(|c| or.design_arena.get(*c).copied().map(|v| clamp01(v / 100.0)))
        .collect();
    mean(&vals)
}

pub fn synthesize(
    model: &str,
    or: Option<&OpenRouterRow>,
    ds: Option<&DeepSweRow>,
    official: Option<&OfficialScores>,
) -> CapabilityProfile {
    let aa_intelligence = or.and_then(|r| r.intelligence_index);
    let aa_coding = or.and_then(|r| r.coding_index);
    let aa_agentic = or.and_then(|r| r.agentic_index);
    let deepswe = ds.map(|r| r.pass_at_1 * 100.0);
    let hle = official.and_then(|s| s.hle);
    let hle_tools = official.and_then(|s| s.hle_tools);
    let swe_verified = official.and_then(|s| s.swe_verified);
    let swe_pro = official.and_then(|s| s.swe_pro);
    let swe_multilingual = official.and_then(|s| s.swe_multilingual);
    let imo = official.and_then(|s| s.imo_answer_bench);

    let benchmarks = BenchmarkScores {
        hle,
        hle_tools,
        swe_verified,
        swe_pro,
        swe_multilingual,
        imo_answer_bench: imo,
        aa_intelligence_index: aa_intelligence,
        aa_coding_index: aa_coding,
        aa_agentic_index: aa_agentic,
        deepswe_pass1: deepswe,
        deepswe_avg_cost_usd: ds.map(|r| r.mean_cost_usd),
        deepswe_avg_output_tokens: ds.map(|r| r.mean_output_tokens),
        deepswe_avg_steps: ds.map(|r| r.mean_agent_steps),
    };

    let coding = weighted_available(
        &[
            norm_pct(deepswe),
            norm_pct(swe_verified),
            norm_pct(swe_pro),
            norm_pct(aa_coding),
        ],
        &[0.35, 0.25, 0.15, 0.25],
    );
    let agentic = weighted_available(
        &[norm_pct(deepswe), norm_pct(swe_verified), norm_pct(aa_agentic)],
        &[0.4, 0.3, 0.3],
    );
    let reasoning = weighted_available(
        &[norm_pct(hle), norm_pct(imo), norm_pct(aa_intelligence)],
        &[0.4, 0.3, 0.3],
    );
    let knowledge = weighted_available(&[norm_pct(hle), norm_pct(aa_intelligence)], &[0.6, 0.4]);
    let main = weighted_available(
        &[
            norm_pct(hle_tools),
            norm_pct(aa_agentic),
            norm_pct(aa_intelligence),
            norm_pct(deepswe),
            norm_pct(swe_verified),
        ],
        &[0.25, 0.25, 0.20, 0.15, 0.15],
    );
    let math = norm_pct(imo);
    let long_context = or.and_then(|r| {
        r.context_length.map(|c| clamp01((c as f64 / 1_000_000.0).min(1.0)))
    });

    let capability = CapabilityScores {
        main,
        coding,
        agentic,
        reasoning,
        knowledge,
        math,
        long_context,
    };

    let directions = DirectionScores {
        frontend: arena(or, &["website", "webapps", "uicomponent"]),
        backend: coding,
        fullstack: arena(or, &["fullstack"]),
        mobile: arena(or, &["androidnative", "mobileapps"]),
        game: arena(or, &["gamedev", "godotgamedev"]),
        data: arena(or, &["dataviz"]),
        design: arena(or, &["logo", "imageediting", "graphicdesign", "svg"]),
        cli: coding,
    };

    let pricing = Pricing {
        input_cost_per_m: or.and_then(|r| r.input_cost_per_m),
        output_cost_per_m: or.and_then(|r| r.output_cost_per_m),
        context_length: or.and_then(|r| r.context_length),
    };

    let cost_efficiency = CostEfficiency {
        coding_quality_per_dollar: pricing.input_cost_per_m.and_then(|price| {
            if price > 0.0 {
                coding.map(|c| c / price)
            } else {
                None
            }
        }),
        deepswe_score_per_dollar: ds.and_then(|r| {
            if r.mean_cost_usd > 0.0 {
                Some(r.pass_at_1 / r.mean_cost_usd.max(0.01))
            } else {
                None
            }
        }),
        deepswe_score_per_output_token: ds.and_then(|r| {
            if r.mean_output_tokens > 0.0 {
                Some(r.pass_at_1 / r.mean_output_tokens * 1000.0)
            } else {
                None
            }
        }),
    };

    let mut sources = Vec::new();
    if or.is_some() {
        sources.push("openrouter".to_string());
    }
    if ds.is_some() {
        sources.push("deepswe".to_string());
    }
    if official.is_some() {
        sources.push("official-report".to_string());
    }
    let confidence = match sources.len() {
        3 => "high".to_string(),
        2 => "medium".to_string(),
        _ => "low".to_string(),
    };

    CapabilityProfile {
        model: model.to_string(),
        updated_at: chrono::Utc::now().to_rfc3339(),
        pricing,
        capability,
        directions,
        benchmarks,
        cost_efficiency,
        sources,
        confidence,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weighted_available_renormalizes() {
        let v = weighted_available(&[Some(0.5), None, Some(1.0)], &[0.5, 0.25, 0.25]);
        assert!((v.unwrap() - 0.6666667).abs() < 1e-5);
    }

    #[test]
    fn synthesize_uses_available_sources() {
        let p = synthesize("m", None, None, None);
        assert_eq!(p.confidence, "low");
        assert!(p.sources.is_empty());
    }
}
