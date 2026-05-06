use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

use crate::state::AppState;
use crate::hyperliquid::market::get_hl_price;

pub async fn price_handler(State(_state): State<AppState>) -> Json<Value> {
    let client = reqwest::Client::new();
    match get_hl_price(&client).await {
        Ok(price) => Json(json!({ "price": price })),
        Err(e) => Json(json!({ "price": 0, "error": e.to_string() })),
    }
}
