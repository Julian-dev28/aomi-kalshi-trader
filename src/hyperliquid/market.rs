use std::collections::HashMap;
use serde_json::{json, Value};
use super::{HL_API, HLAccount, HLPosition};

pub async fn hl_post(client: &reqwest::Client, body: Value) -> anyhow::Result<Value> {
    let res = client
        .post(format!("{}/info", HL_API))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await?;
    let val: Value = res.json().await?;
    Ok(val)
}

pub async fn get_hl_price(client: &reqwest::Client) -> anyhow::Result<f64> {
    let val = hl_post(client, json!({ "type": "allMids" })).await?;
    let mids: HashMap<String, String> = serde_json::from_value(val)?;
    let price = mids.get("BTC").and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
    Ok(price)
}

pub async fn get_hl_account(client: &reqwest::Client, wallet: &str) -> anyhow::Result<HLAccount> {
    let (perp_val, spot_val) = tokio::join!(
        hl_post(client, json!({ "type": "clearinghouseState", "user": wallet })),
        hl_post(client, json!({ "type": "spotClearinghouseState", "user": wallet }))
    );

    let perp_val = perp_val?;
    let spot_val = spot_val?;

    let equity = perp_val["marginSummary"]["accountValue"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);

    let total_ntl = perp_val["marginSummary"]["totalNtlPos"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);

    let spot_usdc = spot_val["balances"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter(|b| {
                    matches!(
                        b["coin"].as_str(),
                        Some("USDC") | Some("USDT") | Some("USD")
                    )
                })
                .filter_map(|b| b["total"].as_str()?.parse::<f64>().ok())
                .sum::<f64>()
        })
        .unwrap_or(0.0);

    let position = perp_val["assetPositions"]
        .as_array()
        .and_then(|positions| {
            positions.iter().find(|p| p["position"]["coin"].as_str() == Some("BTC"))
        })
        .and_then(|btc_pos| {
            let pos = &btc_pos["position"];
            let szi = pos["szi"].as_str()?.parse::<f64>().ok()?;
            if szi == 0.0 {
                return None;
            }
            Some(HLPosition {
                side: if szi > 0.0 {
                    "long".to_string()
                } else {
                    "short".to_string()
                },
                size_btc: szi.abs(),
                entry_px: pos["entryPx"].as_str()?.parse::<f64>().ok()?,
                unrealized_pnl: pos["unrealizedPnl"]
                    .as_str()
                    .and_then(|s| s.parse::<f64>().ok())
                    .unwrap_or(0.0),
                leverage: pos["leverage"]["value"]
                    .as_str()
                    .and_then(|s| s.parse::<f64>().ok())
                    .unwrap_or(5.0),
            })
        });

    Ok(HLAccount {
        equity,
        spot_usdc,
        total_equity: equity + spot_usdc,
        total_ntl,
        position,
    })
}
