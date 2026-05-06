use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

use crate::state::AppState;
use crate::hyperliquid::market::get_hl_account;

pub async fn account_handler(State(state): State<AppState>) -> Json<Value> {
    let client = state.http.clone();
    let wallet = state.config.hl_account.clone();
    match get_hl_account(&client, &wallet).await {
        Ok(account) => Json(json!({
            "equity":      account.equity,
            "spotUSDC":    account.spot_usdc,
            "totalEquity": account.total_equity,
            "totalNtl":    account.total_ntl,
            "position": account.position.map(|p| json!({
                "side":          p.side,
                "sizeBTC":       p.size_btc,
                "entryPx":       p.entry_px,
                "unrealizedPnl": p.unrealized_pnl,
                "leverage":      p.leverage,
            }))
        })),
        Err(e) => Json(json!({ "error": e.to_string() })),
    }
}
