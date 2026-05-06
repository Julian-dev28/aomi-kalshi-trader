use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::state::AppState;
use crate::hyperliquid::market::hl_post;

#[derive(Deserialize)]
pub struct CandlesQuery {
    window: Option<String>,
}

pub async fn candles_handler(
    State(_state): State<AppState>,
    Query(params): Query<CandlesQuery>,
) -> Json<Value> {
    let window = params.window.as_deref().unwrap_or("1h");

    let window_ms: std::collections::HashMap<&str, u64> = [
        ("15m", 15 * 60 * 1000),
        ("30m", 30 * 60 * 1000),
        ("1h", 60 * 60 * 1000),
    ]
    .iter()
    .cloned()
    .collect();

    let ms = window_ms.get(window).copied().unwrap_or(60 * 60 * 1000);
    let interval = "1m";
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let end_time = now;
    let start_time = end_time.saturating_sub(ms);

    let client = reqwest::Client::new();
    match hl_post(
        &client,
        json!({
            "type": "candleSnapshot",
            "req": {
                "coin": "BTC",
                "interval": interval,
                "startTime": start_time,
                "endTime": end_time
            }
        }),
    )
    .await
    {
        Ok(raw) => {
            let candles: Vec<Value> = raw
                .as_array()
                .unwrap_or(&vec![])
                .iter()
                .map(|c| {
                    json!({
                        "t": c["t"],
                        "o": c["o"].as_str().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0),
                        "h": c["h"].as_str().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0),
                        "l": c["l"].as_str().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0),
                        "c": c["c"].as_str().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0),
                        "v": c["v"].as_str().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0),
                    })
                })
                .collect();
            Json(json!({ "candles": candles }))
        }
        Err(e) => Json(json!({ "candles": [], "error": e.to_string() })),
    }
}
