use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

use crate::state::AppState;
use crate::hyperliquid::market::get_hl_price;

pub async fn price_handler(State(state): State<AppState>) -> Json<Value> {
    match get_hl_price(&state.http).await {
        Ok(price) => Json(json!({ "price": price })),
        Err(e) => Json(json!({ "price": 0, "error": e.to_string() })),
    }
}
