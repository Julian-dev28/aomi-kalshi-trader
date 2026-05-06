use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::state::AppState;
use crate::hyperliquid::market::{get_hl_account, get_hl_price};
use crate::hyperliquid::signing::{place_hl_order, set_leverage, transfer_spot_to_perp};
use crate::hyperliquid::HL_LEVERAGE;

#[derive(Deserialize)]
pub struct PlaceOrderRequest {
    pub side: String,
    pub risk_usd: Option<f64>,
    #[serde(rename = "riskPct")]
    pub risk_pct: Option<f64>,
    pub leverage: Option<u32>,
}

pub async fn place_order_handler(
    State(state): State<AppState>,
    Json(body): Json<PlaceOrderRequest>,
) -> Json<Value> {
    let cfg = &state.config;
    let client = state.http.clone();

    let leverage = body.leverage.unwrap_or(HL_LEVERAGE);

    let (price_res, account_res) = tokio::join!(
        get_hl_price(&client),
        get_hl_account(&client, &cfg.hl_account)
    );

    let mid_price = match price_res {
        Ok(p) if p > 0.0 => p,
        _ => return Json(json!({ "ok": false, "error": "invalid price" })),
    };

    let mut account = match account_res {
        Ok(a) => a,
        Err(e) => return Json(json!({ "ok": false, "error": e.to_string() })),
    };

    // If perp equity is 0 but we have spot USDC, transfer it
    if account.equity == 0.0 && account.spot_usdc > 0.0 {
        let amount = account.spot_usdc;
        let _ = transfer_spot_to_perp(&client, &cfg.hl_private_key, amount).await;
        if let Ok(updated) = get_hl_account(&client, &cfg.hl_account).await {
            account = updated;
        }
    }

    let total_equity = account.total_equity;
    let risk_usd = body.risk_usd.filter(|&v| v > 0.0).unwrap_or_else(|| {
        if total_equity > 0.0 {
            total_equity * body.risk_pct.unwrap_or(2.0) / 100.0
        } else {
            0.0
        }
    });

    let notional = f64::max(risk_usd * leverage as f64, mid_price * 0.001);
    let size_btc = (notional / mid_price * 100000.0).floor() / 100000.0;
    let is_buy = body.side == "long";

    let _ = set_leverage(&client, &cfg.hl_private_key, leverage).await;

    match place_hl_order(&client, &cfg.hl_private_key, is_buy, size_btc, mid_price).await {
        Ok(result) => Json(json!({
            "ok":       result.ok,
            "orderId":  result.order_id,
            "error":    result.error,
            "sizeBTC":  size_btc,
            "midPrice": mid_price,
            "equity":   total_equity,
            "leverage": leverage,
        })),
        Err(e) => Json(json!({ "ok": false, "error": e.to_string() })),
    }
}
