//! OpenRouter auto-provider: selects provider slugs from the OpenRouter
//! endpoint metadata API. Port of AstroEX-node src/astroAutoProvider.ts.

use crate::error::{AppError, Result};
use std::collections::HashSet;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub const API_BASE: &str = "https://openrouter.ai/api/v1";
const ONE_MILLION: f64 = 1_000_000.0;
pub const REQUIRED_QUANTIZATION: &str = "fp8";
pub const DEFAULT_TOP: u32 = 3;
pub const DEFAULT_MIN_UPTIME: f64 = 95.0;
pub const DEFAULT_MAX_PRICE_VS_MEDIAN: f64 = 1.1;
pub const REQUEST_TIMEOUT_MS: u64 = 30_000;

pub const ASTRO_AUTO_PROVIDER: &str = "astro_auto_provider";

/// One normalized endpoint row (TS ProviderRow).
#[derive(Debug, Clone)]
pub struct ProviderRow {
    pub provider: String,
    pub provider_slug: String,
    pub quantization: String,
    pub input_per_m: Option<f64>,
    pub output_per_m: Option<f64>,
    pub cache_read_per_m: Option<f64>,
    pub latency_s: Option<f64>,
    pub throughput_tps: Option<f64>,
    pub uptime_pct: Option<f64>,
    pub combined_per_m: Option<f64>,
    pub throughput_per_dollar: Option<f64>,
}

/// Parameters for [`astro_auto_provider`] (TS AstroAutoProviderOptions).
#[derive(Debug, Clone)]
pub struct AstroAutoProviderParams {
    pub model_id: String,
    pub api_key: String,
    pub top: Option<u32>,
    pub quantizations: Option<Vec<String>>,
    pub min_uptime: Option<f64>,
    pub max_price_vs_median: Option<f64>,
    pub signal: CancellationToken,
}

/// Structured selection result (TS AstroAutoProviderResult).
#[derive(Debug, Clone)]
pub struct AstroAutoProviderResult {
    pub model_id: String,
    pub providers: Vec<ProviderRow>,
    pub provider_slugs: Vec<String>,
    pub median_price: Option<f64>,
    pub max_price: Option<f64>,
    pub excluded_count: usize,
    pub all_endpoints_count: usize,
    pub fp8_endpoints_count: usize,
    pub no_details_output: String,
}

#[derive(Debug, Clone)]
pub struct SelectionResult {
    providers: Vec<ProviderRow>,
    median_price: Option<f64>,
    max_price: Option<f64>,
    excluded_count: usize,
}

fn as_number(value: Option<&serde_json::Value>) -> Option<f64> {
    let value = value?;
    match value {
        serde_json::Value::Null => None,
        serde_json::Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        serde_json::Value::Number(n) => n.as_f64().filter(|n| n.is_finite()),
        serde_json::Value::String(s) => {
            if s.is_empty() {
                None
            } else {
                s.parse::<f64>().ok().filter(|n| n.is_finite())
            }
        }
        _ => None,
    }
}

fn fmt_number(value: Option<f64>, places: usize) -> String {
    let value = match value {
        Some(v) if v.is_finite() => v,
        _ => return "--".to_string(),
    };
    let mut formatted = format!("{value:.places$}");
    if formatted.contains('.') {
        while formatted.ends_with('0') {
            formatted.pop();
        }
        if formatted.ends_with('.') {
            formatted.pop();
        }
    }
    formatted
}

fn format_local_date_time() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

fn price_per_million(pricing: &serde_json::Value, key: &str) -> Option<f64> {
    as_number(pricing.get(key)).map(|price| price * ONE_MILLION)
}

fn metric_p50(value: Option<&serde_json::Value>) -> Option<f64> {
    match value {
        Some(v @ serde_json::Value::Object(_)) => as_number(v.get("p50")),
        Some(other) => as_number(Some(other)),
        None => None,
    }
}

fn get_base_pricing(endpoint: &serde_json::Value) -> serde_json::Value {
    match endpoint.get("pricing") {
        Some(serde_json::Value::Array(pricing)) => pricing
            .first()
            .filter(|first| first.is_object())
            .cloned()
            .unwrap_or_else(|| serde_json::Value::Object(Default::default())),
        Some(v @ serde_json::Value::Object(_)) => v.clone(),
        _ => serde_json::Value::Object(Default::default()),
    }
}

fn median(mut values: Vec<f64>) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let middle = values.len() / 2;
    if values.len().is_multiple_of(2) {
        Some((values[middle - 1] + values[middle]) / 2.0)
    } else {
        Some(values[middle])
    }
}

fn assert_model_id(model_id: &str) -> Result<(String, String)> {
    let mut parts = model_id.splitn(2, '/');
    let author = parts.next().unwrap_or("");
    let slug = parts.next().unwrap_or("");
    if author.is_empty() || slug.is_empty() {
        return Err(AppError::message(
            r#"MODEL_ID must look like "author/model"."#,
        ));
    }
    Ok((author.to_string(), slug.to_string()))
}

fn encode_uri_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        let ch = *byte as char;
        if ch.is_ascii_alphanumeric()
            || matches!(ch, '-' | '_' | '.' | '!' | '~' | '*' | '\'' | '(' | ')')
        {
            encoded.push(ch);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

async fn fetch_endpoints(
    model_id: &str,
    api_key: &str,
    signal: &CancellationToken,
) -> Result<Vec<serde_json::Value>> {
    let (author, slug) = assert_model_id(model_id)?;
    let url = format!(
        "{API_BASE}/models/{}/{}/endpoints",
        encode_uri_component(&author),
        encode_uri_component(&slug)
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(REQUEST_TIMEOUT_MS))
        .build()
        .map_err(AppError::from)?;
    let request = client
        .get(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Accept", "application/json")
        .header("HTTP-Referer", "https://github.com/sudoTni/AstroOM")
        .header("X-Title", "AstroOM")
        .send();
    let response = tokio::select! {
        response = request => match response {
            Ok(response) => response,
            Err(err) if err.is_timeout() => {
                return Err(AppError::timeout("OpenRouter request timed out after 30s."));
            }
            Err(err) => return Err(AppError::from(err)),
        },
        _ = signal.cancelled() => {
            return Err(AppError::message("Pipeline cancelled before operation started"));
        }
    };
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let body: String = body.chars().take(1000).collect();
        return Err(AppError::new(
            "OPENROUTER_HTTP_ERROR",
            status.as_u16(),
            format!("OpenRouter returned HTTP {}\n{}", status.as_u16(), body),
        ));
    }
    let payload: serde_json::Value = response.json().await.map_err(AppError::from)?;
    match payload.get("data").and_then(|data| data.get("endpoints")) {
        Some(serde_json::Value::Array(endpoints)) => Ok(endpoints
            .iter()
            .filter(|endpoint| endpoint.is_object())
            .cloned()
            .collect()),
        _ => Err(AppError::message("Unexpected OpenRouter response shape.")),
    }
}

fn is_endpoint_quantization_eligible(
    endpoint: &serde_json::Value,
    allowed_quantizations: &[String],
) -> bool {
    match endpoint.get("quantization") {
        Some(serde_json::Value::String(quantization)) => {
            allowed_quantizations.contains(&quantization.to_lowercase())
        }
        _ => false,
    }
}

fn normalize_endpoint(endpoint: &serde_json::Value) -> ProviderRow {
    let pricing = get_base_pricing(endpoint);
    let input_per_m = price_per_million(&pricing, "prompt");
    let output_per_m = price_per_million(&pricing, "completion");
    let cache_read_per_m = price_per_million(&pricing, "input_cache_read");
    let latency_s = metric_p50(endpoint.get("latency_last_30m"));
    let throughput_tps = metric_p50(endpoint.get("throughput_last_30m"));
    let uptime_pct = as_number(endpoint.get("uptime_last_1d"));
    let mut combined_per_m: Option<f64> = None;
    let mut throughput_per_dollar: Option<f64> = None;
    if let (Some(input), Some(output), Some(cache_read)) =
        (input_per_m, output_per_m, cache_read_per_m)
    {
        combined_per_m = Some(input + output + cache_read);
        if let (Some(throughput), Some(price)) = (throughput_tps, combined_per_m) {
            if price > 0.0 {
                throughput_per_dollar = Some(throughput / price);
            }
        }
    }
    let provider = endpoint
        .get("provider_name")
        .and_then(serde_json::Value::as_str)
        .filter(|name| !name.is_empty())
        .or_else(|| {
            endpoint
                .get("name")
                .and_then(serde_json::Value::as_str)
                .filter(|name| !name.is_empty())
        })
        .unwrap_or("Unknown")
        .to_string();
    ProviderRow {
        provider,
        provider_slug: endpoint
            .get("tag")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string(),
        quantization: endpoint
            .get("quantization")
            .and_then(serde_json::Value::as_str)
            .map(|q| q.to_lowercase())
            .unwrap_or_default(),
        input_per_m,
        output_per_m,
        cache_read_per_m,
        latency_s,
        throughput_tps,
        uptime_pct,
        combined_per_m,
        throughput_per_dollar,
    }
}

fn base_eligible_rows(
    rows: &[ProviderRow],
    min_uptime: f64,
    allowed_quantizations: Option<&[String]>,
) -> Vec<ProviderRow> {
    rows.iter()
        .filter(|row| {
            let quantization_ok = match allowed_quantizations {
                Some(allowed) => allowed.contains(&row.quantization),
                None => row.quantization == REQUIRED_QUANTIZATION,
            };
            quantization_ok
                && matches!(row.combined_per_m, Some(price) if price > 0.0)
                && row.throughput_per_dollar.is_some()
                && row.throughput_tps.is_some()
                && matches!(row.uptime_pct, Some(uptime) if uptime >= min_uptime)
                && !row.provider_slug.is_empty()
        })
        .cloned()
        .collect()
}

fn compare_providers(a: &ProviderRow, b: &ProviderRow) -> std::cmp::Ordering {
    let efficiency =
        b.throughput_per_dollar.unwrap_or(0.0) - a.throughput_per_dollar.unwrap_or(0.0);
    if efficiency != 0.0 {
        return if efficiency > 0.0 {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Less
        };
    }
    let throughput = b.throughput_tps.unwrap_or(0.0) - a.throughput_tps.unwrap_or(0.0);
    if throughput != 0.0 {
        return if throughput > 0.0 {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Less
        };
    }
    let price =
        a.combined_per_m.unwrap_or(f64::INFINITY) - b.combined_per_m.unwrap_or(f64::INFINITY);
    if price != 0.0 {
        return if price < 0.0 {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        };
    }
    let uptime = b.uptime_pct.unwrap_or(0.0) - a.uptime_pct.unwrap_or(0.0);
    if uptime != 0.0 {
        return if uptime > 0.0 {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Less
        };
    }
    let latency = a.latency_s.unwrap_or(f64::INFINITY) - b.latency_s.unwrap_or(f64::INFINITY);
    if latency != 0.0 {
        return if latency < 0.0 {
            std::cmp::Ordering::Less
        } else {
            std::cmp::Ordering::Greater
        };
    }
    std::cmp::Ordering::Equal
}

/// Pure ranking pipeline over already-parsed endpoint rows: base eligibility,
/// median-price outlier exclusion, ranking, slug dedup, and top-N truncation.
pub fn top_providers(
    rows: &[ProviderRow],
    top_n: usize,
    min_uptime: f64,
    max_price_vs_median: f64,
    allowed_quantizations: Option<&[String]>,
) -> SelectionResult {
    let eligible = base_eligible_rows(rows, min_uptime, allowed_quantizations);
    if eligible.is_empty() {
        return SelectionResult {
            providers: Vec::new(),
            median_price: None,
            max_price: None,
            excluded_count: 0,
        };
    }
    let prices: Vec<f64> = eligible
        .iter()
        .filter_map(|row| row.combined_per_m)
        .filter(|price| *price > 0.0)
        .collect();
    let median_price = median(prices);
    let max_price = median_price.map(|m| m * max_price_vs_median);
    let mut accepted: Vec<ProviderRow> = eligible
        .iter()
        .filter(|row| match max_price {
            Some(max_price) => row
                .combined_per_m
                .map(|price| price <= max_price)
                .unwrap_or(false),
            None => true,
        })
        .cloned()
        .collect();
    let excluded_count = eligible.len() - accepted.len();
    accepted.sort_by(compare_providers);
    let mut providers: Vec<ProviderRow> = Vec::new();
    let mut seen_slugs: HashSet<String> = HashSet::new();
    for row in accepted {
        if !seen_slugs.insert(row.provider_slug.clone()) {
            continue;
        }
        providers.push(row);
        if providers.len() >= top_n {
            break;
        }
    }
    SelectionResult {
        providers,
        median_price,
        max_price,
        excluded_count,
    }
}

fn format_top(rows: &[ProviderRow], quant_label: &str) -> String {
    if rows.is_empty() {
        return format!("No eligible {quant_label} providers remained after filtering.");
    }
    let headers = [
        "#",
        "Provider",
        "Slug",
        "Quant",
        "Combined /M",
        "TPS",
        "TPS/$",
        "Uptime",
        "Latency",
    ];
    let body: Vec<Vec<String>> = rows
        .iter()
        .enumerate()
        .map(|(index, row)| {
            vec![
                (index + 1).to_string(),
                row.provider.clone(),
                row.provider_slug.clone(),
                row.quantization.clone(),
                format!("${}", fmt_number(row.combined_per_m, 6)),
                fmt_number(row.throughput_tps, 2),
                fmt_number(row.throughput_per_dollar, 2),
                format!("{}%", fmt_number(row.uptime_pct, 2)),
                match row.latency_s {
                    None => "--".to_string(),
                    Some(latency) => format!("{}s", fmt_number(Some(latency), 3)),
                },
            ]
        })
        .collect();
    let widths: Vec<usize> = headers
        .iter()
        .enumerate()
        .map(|(column, header)| {
            let mut width = header.len();
            for row in &body {
                width = width.max(row[column].len());
            }
            width
        })
        .collect();
    let line = |values: Vec<String>| -> String {
        values
            .iter()
            .zip(widths.iter())
            .map(|(value, width)| format!("{value:<width$}"))
            .collect::<Vec<_>>()
            .join("  ")
    };
    let mut lines = vec![
        line(headers.iter().map(|h| h.to_string()).collect()),
        line(widths.iter().map(|w| "-".repeat(*w)).collect()),
    ];
    for row in body {
        lines.push(line(row));
    }
    lines.push(String::new());
    lines.push("Provider slugs:".to_string());
    lines.push(
        rows.iter()
            .map(|row| row.provider_slug.clone())
            .collect::<Vec<_>>()
            .join(","),
    );
    lines.join("\n")
}

fn allowed_quantizations(quantizations: Option<&[String]>) -> Vec<String> {
    let mut allowed: Vec<String> = Vec::new();
    if let Some(quantizations) = quantizations {
        for quantization in quantizations {
            let normalized = quantization.trim().to_lowercase();
            if !normalized.is_empty() && !allowed.contains(&normalized) {
                allowed.push(normalized);
            }
        }
    }
    if allowed.is_empty() {
        allowed.push(REQUIRED_QUANTIZATION.to_string());
    }
    allowed
}

fn quantization_label(allowed: &[String]) -> String {
    if allowed.len() == 1 && allowed[0] == REQUIRED_QUANTIZATION {
        return "FP8".to_string();
    }
    allowed
        .iter()
        .map(|q| q.to_uppercase())
        .collect::<Vec<_>>()
        .join("/")
}

pub async fn astro_auto_provider(
    params: AstroAutoProviderParams,
) -> Result<AstroAutoProviderResult> {
    let api_key = params.api_key.trim().to_string();
    if api_key.is_empty() {
        return Err(AppError::message("--api-key is not set."));
    }
    let top = params.top.unwrap_or(DEFAULT_TOP);
    let min_uptime = params.min_uptime.unwrap_or(DEFAULT_MIN_UPTIME);
    let max_price_vs_median = params
        .max_price_vs_median
        .unwrap_or(DEFAULT_MAX_PRICE_VS_MEDIAN);
    if top < 1 {
        return Err(AppError::message("--top must be an integer of at least 1."));
    }
    if !(0.0..=100.0).contains(&min_uptime) {
        return Err(AppError::message("--min-uptime must be between 0 and 100."));
    }
    if max_price_vs_median <= 0.0 {
        return Err(AppError::message(
            "--max-price-vs-median must be greater than 0.",
        ));
    }

    let allowed = allowed_quantizations(params.quantizations.as_deref());
    let quant_label = quantization_label(&allowed);

    let all_endpoints = fetch_endpoints(&params.model_id, &api_key, &params.signal).await?;
    let eligible_endpoints: Vec<&serde_json::Value> = all_endpoints
        .iter()
        .filter(|endpoint| is_endpoint_quantization_eligible(endpoint, &allowed))
        .collect();
    let rows: Vec<ProviderRow> = eligible_endpoints
        .iter()
        .map(|endpoint| normalize_endpoint(endpoint))
        .collect();
    let selection = top_providers(
        &rows,
        top as usize,
        min_uptime,
        max_price_vs_median,
        Some(&allowed),
    );
    let provider_slugs: Vec<String> = selection
        .providers
        .iter()
        .map(|row| row.provider_slug.clone())
        .collect();
    let no_details_output = format!(
        "Model: {}\nDate & time: {}\n{}",
        params.model_id,
        format_local_date_time(),
        format_top(&selection.providers, &quant_label)
    );
    Ok(AstroAutoProviderResult {
        model_id: params.model_id,
        providers: selection.providers,
        provider_slugs,
        median_price: selection.median_price,
        max_price: selection.max_price,
        excluded_count: selection.excluded_count,
        all_endpoints_count: all_endpoints.len(),
        fp8_endpoints_count: eligible_endpoints.len(),
        no_details_output,
    })
}

/// Library equivalent of the standalone selector's --help text (TS
/// astroAutoProviderUsage). Env-var references reworded to --api-key.
pub fn astro_auto_provider_usage() -> String {
    format!(
        r#"Usage:
  openrouter_providers.ts MODEL_ID [options]

Options:
  --top N                         Maximum unique providers to return (default: {DEFAULT_TOP})
  --min-uptime PERCENT            Minimum 1-day uptime percentage (default: {DEFAULT_MIN_UPTIME})
  --max-price-vs-median MULTIPLIER
                                  Exclude providers priced above median × multiplier
                                  (default: {DEFAULT_MAX_PRICE_VS_MEDIAN:.2})
  --plain                         Print only final comma-separated provider slugs
  --no-details                    Print model, results table, and provider slugs
  -h, --help                      Show this help
  --api-key KEY                   OpenRouter API key

Examples:
  npx tsx openrouter_providers.ts deepseek/deepseek-v3.2
  npx tsx openrouter_providers.ts z-ai/glm-4.5-air --top 4
  npx tsx openrouter_providers.ts z-ai/glm-4.5-air --plain
  npx tsx openrouter_providers.ts z-ai/glm-4.5-air --no-details
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const DEFAULT_PRICE: f64 = 0.000001;

    #[allow(clippy::too_many_arguments)]
    fn fixture_endpoint(
        tag: &str,
        quantization: &str,
        prompt: f64,
        completion: f64,
        cache: f64,
        throughput: f64,
        uptime: f64,
        latency: f64,
    ) -> serde_json::Value {
        json!({
            "provider_name": tag,
            "tag": tag,
            "quantization": quantization,
            "pricing": {
                "prompt": prompt.to_string(),
                "completion": completion.to_string(),
                "input_cache_read": cache.to_string(),
            },
            "throughput_last_30m": { "p50": throughput },
            "uptime_last_1d": uptime,
            "latency_last_30m": { "p50": latency },
        })
    }

    fn simple_endpoint(tag: &str, quantization: &str, throughput: f64) -> serde_json::Value {
        fixture_endpoint(
            tag,
            quantization,
            DEFAULT_PRICE,
            DEFAULT_PRICE,
            DEFAULT_PRICE,
            throughput,
            99.0,
            0.5,
        )
    }

    fn run_selection(
        endpoints: &[serde_json::Value],
        top: u32,
        quantizations: Option<Vec<&str>>,
    ) -> (Vec<String>, usize, String) {
        let quantizations_owned: Option<Vec<String>> =
            quantizations.map(|qs| qs.iter().map(|q| q.to_string()).collect());
        let allowed = allowed_quantizations(quantizations_owned.as_deref());
        let rows: Vec<ProviderRow> = endpoints
            .iter()
            .filter(|endpoint| is_endpoint_quantization_eligible(endpoint, &allowed))
            .map(normalize_endpoint)
            .collect();
        let selection = top_providers(
            &rows,
            top as usize,
            DEFAULT_MIN_UPTIME,
            DEFAULT_MAX_PRICE_VS_MEDIAN,
            Some(&allowed),
        );
        let label = quantization_label(&allowed);
        let table = format_top(&selection.providers, &label);
        (
            selection
                .providers
                .iter()
                .map(|row| row.provider_slug.clone())
                .collect(),
            selection.excluded_count,
            table,
        )
    }

    #[test]
    fn sentinel_is_astro_auto_provider() {
        assert_eq!(ASTRO_AUTO_PROVIDER, "astro_auto_provider");
    }

    #[test]
    fn selects_and_formats_ranked_fp8_providers() {
        let endpoints = vec![
            simple_endpoint("fast", "fp8", 90.0),
            simple_endpoint("steady", "fp8", 60.0),
            fixture_endpoint(
                "outlier", "fp8", 0.000005, 0.000005, 0.000005, 999.0, 99.0, 0.5,
            ),
            simple_endpoint("not-fp8", "bf16", 999.0),
            simple_endpoint("fast", "fp8", 80.0),
        ];
        let (slugs, excluded_count, table) = run_selection(&endpoints, DEFAULT_TOP, None);
        assert_eq!(slugs, vec!["fast", "steady"]);
        assert_eq!(excluded_count, 1);
        assert!(table.contains("$3"));
        assert!(table.ends_with("Provider slugs:\nfast,steady"));
    }

    #[test]
    fn reports_empty_selection_without_inventing_a_provider() {
        let endpoints = vec![simple_endpoint("bf16", "bf16", 50.0)];
        let (slugs, excluded_count, table) = run_selection(&endpoints, DEFAULT_TOP, None);
        assert!(slugs.is_empty());
        assert_eq!(excluded_count, 0);
        assert!(table.ends_with("No eligible FP8 providers remained after filtering."));
    }

    #[test]
    fn defaults_to_selecting_three_provider_slugs() {
        let endpoints: Vec<serde_json::Value> = (1..=6)
            .map(|i| simple_endpoint(&format!("p{i}"), "fp8", 110.0 - 10.0 * i as f64))
            .collect();
        let (slugs, _, _) = run_selection(&endpoints, DEFAULT_TOP, None);
        assert_eq!(slugs, vec!["p1", "p2", "p3"]);
    }

    #[test]
    fn respects_explicit_top_override() {
        let endpoints: Vec<serde_json::Value> = (1..=6)
            .map(|i| simple_endpoint(&format!("p{i}"), "fp8", 110.0 - 10.0 * i as f64))
            .collect();
        let (slugs, _, _) = run_selection(&endpoints, 5, None);
        assert_eq!(slugs, vec!["p1", "p2", "p3", "p4", "p5"]);
    }

    #[test]
    fn filters_endpoints_by_configured_quantizations() {
        let endpoints = vec![
            simple_endpoint("int8-fast", "int8", 90.0),
            simple_endpoint("fp8-fast", "fp8", 100.0),
            simple_endpoint("int8-steady", "int8", 70.0),
            simple_endpoint("bf16-fast", "bf16", 120.0),
        ];
        let (slugs, _, table) = run_selection(&endpoints, DEFAULT_TOP, Some(vec!["int8"]));
        assert_eq!(slugs, vec!["int8-fast", "int8-steady"]);
        assert!(table.ends_with("Provider slugs:\nint8-fast,int8-steady"));
    }

    #[test]
    fn formats_empty_selection_message_for_custom_quantization() {
        let endpoints = vec![simple_endpoint("fp8", "fp8", 50.0)];
        let (slugs, _, table) = run_selection(&endpoints, DEFAULT_TOP, Some(vec!["int4"]));
        assert!(slugs.is_empty());
        assert!(table.ends_with("No eligible INT4 providers remained after filtering."));
    }

    #[test]
    fn rejects_model_ids_without_author_slug_shape() {
        let err = assert_model_id("invalid").unwrap_err();
        assert_eq!(err.message, r#"MODEL_ID must look like "author/model"."#);
    }

    #[tokio::test]
    async fn rejects_missing_api_key_before_any_network_call() {
        let err = astro_auto_provider(AstroAutoProviderParams {
            model_id: "author/model".to_string(),
            api_key: "   ".to_string(),
            top: None,
            quantizations: None,
            min_uptime: None,
            max_price_vs_median: None,
            signal: CancellationToken::new(),
        })
        .await
        .unwrap_err();
        assert_eq!(err.message, "--api-key is not set.");
    }

    #[tokio::test]
    async fn rejects_invalid_model_id_shape() {
        let err = astro_auto_provider(AstroAutoProviderParams {
            model_id: "invalid".to_string(),
            api_key: "test-key".to_string(),
            top: None,
            quantizations: None,
            min_uptime: None,
            max_price_vs_median: None,
            signal: CancellationToken::new(),
        })
        .await
        .unwrap_err();
        assert_eq!(err.message, r#"MODEL_ID must look like "author/model"."#);
    }

    #[tokio::test]
    async fn rejects_out_of_range_options() {
        let base = || AstroAutoProviderParams {
            model_id: "author/model".to_string(),
            api_key: "test-key".to_string(),
            top: None,
            quantizations: None,
            min_uptime: None,
            max_price_vs_median: None,
            signal: CancellationToken::new(),
        };
        let err = astro_auto_provider(AstroAutoProviderParams {
            min_uptime: Some(101.0),
            ..base()
        })
        .await
        .unwrap_err();
        assert_eq!(err.message, "--min-uptime must be between 0 and 100.");
        let err = astro_auto_provider(AstroAutoProviderParams {
            max_price_vs_median: Some(0.0),
            ..base()
        })
        .await
        .unwrap_err();
        assert_eq!(err.message, "--max-price-vs-median must be greater than 0.");
        let err = astro_auto_provider(AstroAutoProviderParams {
            top: Some(0),
            ..base()
        })
        .await
        .unwrap_err();
        assert_eq!(err.message, "--top must be an integer of at least 1.");
    }

    #[test]
    fn usage_text_uses_api_key_flag_not_env_var() {
        let usage = astro_auto_provider_usage();
        assert!(usage.contains("--api-key"));
        assert!(!usage.contains("AEX_OR_API_KEY"));
        assert!(usage.contains("(default: 3)"));
        assert!(usage.contains("(default: 95)"));
        assert!(usage.contains("(default: 1.10)"));
    }

    #[test]
    fn fmt_number_trims_trailing_zeros() {
        assert_eq!(fmt_number(Some(90.0), 2), "90");
        assert_eq!(fmt_number(Some(2.5), 6), "2.5");
        assert_eq!(fmt_number(Some(0.25), 3), "0.25");
        assert_eq!(fmt_number(None, 2), "--");
    }
}
