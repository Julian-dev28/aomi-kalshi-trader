use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

use crate::state::AppState;
use crate::hyperliquid::market::{get_hl_account, get_hl_price};
use crate::hyperliquid::signing::place_hl_order;

pub async fn close_position_handler(State(state): State<AppState>) -> Json<Value> {
    let cfg = &state.config;
    let client = state.http.clone();

    let (price_res, account_res) = tokio::join!(
        get_hl_price(&client),
        get_hl_account(&client, &cfg.hl_account)
    );

    let mid_price = match price_res {
        Ok(p) if p > 0.0 => p,
        _ => return Json(json!({ "ok": false, "error": "invalid price" })),
    };

    let account = match account_res {
        Ok(a) => a,
        Err(e) => return Json(json!({ "ok": false, "error": e.to_string() })),
    };

    let position = match account.position {
        Some(p) => p,
        None => return Json(json!({ "ok": false, "error": "no open position" })),
    };

    let is_buy = position.side == "short"; // closing short = buying
    let size_btc = position.size_btc;

    match place_hl_order(&client, &cfg.hl_private_key, is_buy, size_btc, mid_price).await {
        Ok(result) => Json(json!({
            "ok":       result.ok,
            "orderId":  result.order_id,
            "error":    result.error,
            "sizeBTC":  size_btc,
            "midPrice": mid_price,
        })),
        Err(e) => Json(json!({ "ok": false, "error": e.to_string() })),
    }
}
