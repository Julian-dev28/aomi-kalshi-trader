use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

use crate::state::AppState;
use crate::hyperliquid::market::hl_post;

pub async fn orderbook_handler(State(_state): State<AppState>) -> Json<Value> {
    let client = reqwest::Client::new();
    match hl_post(&client, json!({ "type": "l2Book", "coin": "BTC" })).await {
        Ok(data) => {
            let empty = vec![];
            let bids_raw = data["levels"][0].as_array().unwrap_or(&empty);
            let asks_raw = data["levels"][1].as_array().unwrap_or(&empty);

            let bids: Vec<Value> = bids_raw
                .iter()
                .take(8)
                .map(|l| json!({ "px": l["px"], "sz": l["sz"] }))
                .collect();
            let asks: Vec<Value> = asks_raw
                .iter()
                .take(8)
                .map(|l| json!({ "px": l["px"], "sz": l["sz"] }))
                .collect();

            Json(json!({ "bids": bids, "asks": asks }))
        }
        Err(e) => Json(json!({ "bids": [], "asks": [], "error": e.to_string() })),
    }
}
