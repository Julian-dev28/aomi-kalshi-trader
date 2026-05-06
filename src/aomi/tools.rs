use serde_json::{json, Value};
use std::collections::HashMap;

use crate::hyperliquid::market::hl_post;

pub async fn execute_tool(
    client: &reqwest::Client,
    name: &str,
    args: &HashMap<String, Value>,
    hl_account: &str,
    brave_api_key: Option<&str>,
) -> String {
    let user = args
        .get("user")
        .and_then(|v| v.as_str())
        .unwrap_or(hl_account)
        .to_string();

    match name {
        "get_all_mids" => {
            match hl_post(client, json!({ "type": "allMids" })).await {
                Ok(v) => v.to_string(),
                Err(e) => json!({ "error": e.to_string() }).to_string(),
            }
        }

        "get_l2_book" => {
            let coin = args
                .get("coin")
                .and_then(|v| v.as_str())
                .unwrap_or("BTC");
            let n_levels = args
                .get("nLevels")
                .and_then(|v| v.as_u64())
                .unwrap_or(20);
            match hl_post(
                client,
                json!({ "type": "l2Book", "coin": coin, "nLevels": n_levels }),
            )
            .await
            {
                Ok(v) => v.to_string(),
                Err(e) => json!({ "error": e.to_string() }).to_string(),
            }
        }

        "get_clearinghouse_state" => {
            match hl_post(
                client,
                json!({ "type": "clearinghouseState", "user": user }),
            )
            .await
            {
                Ok(v) => v.to_string(),
                Err(e) => json!({ "error": e.to_string() }).to_string(),
            }
        }

        "get_open_orders" => {
            match hl_post(client, json!({ "type": "openOrders", "user": user })).await {
                Ok(v) => v.to_string(),
                Err(e) => json!({ "error": e.to_string() }).to_string(),
            }
        }

        "get_user_fills" => {
            match hl_post(client, json!({ "type": "userFills", "user": user })).await {
                Ok(v) => v.to_string(),
                Err(e) => json!({ "error": e.to_string() }).to_string(),
            }
        }

        "get_funding_history" => {
            let coin = args
                .get("coin")
                .and_then(|v| v.as_str())
                .unwrap_or("BTC");
            let start_time = args
                .get("startTime")
                .and_then(|v| v.as_u64())
                .unwrap_or_else(|| {
                    (std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_millis() as u64)
                        .saturating_sub(86_400_000)
                });
            match hl_post(
                client,
                json!({ "type": "fundingHistory", "coin": coin, "startTime": start_time }),
            )
            .await
            {
                Ok(v) => v.to_string(),
                Err(e) => json!({ "error": e.to_string() }).to_string(),
            }
        }

        "get_candle_snapshot" => {
            let coin = args
                .get("coin")
                .and_then(|v| v.as_str())
                .unwrap_or("BTC");
            let interval = args
                .get("interval")
                .and_then(|v| v.as_str())
                .unwrap_or("15m");
            let count = args
                .get("count")
                .and_then(|v| v.as_u64())
                .unwrap_or(10);

            let ms_per_candle: HashMap<&str, u64> = [
                ("1m", 60_000),
                ("5m", 300_000),
                ("15m", 900_000),
                ("1h", 3_600_000),
                ("4h", 14_400_000),
                ("1d", 86_400_000),
            ]
            .iter()
            .cloned()
            .collect();

            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64;
            let ms = ms_per_candle.get(interval).copied().unwrap_or(900_000);
            let end_time = now;
            let start_time = end_time.saturating_sub(ms * count);

            match hl_post(
                client,
                json!({
                    "type": "candleSnapshot",
                    "req": {
                        "coin": coin,
                        "interval": interval,
                        "startTime": start_time,
                        "endTime": end_time
                    }
                }),
            )
            .await
            {
                Ok(v) => v.to_string(),
                Err(e) => json!({ "error": e.to_string() }).to_string(),
            }
        }

        "get_meta" => {
            match hl_post(client, json!({ "type": "meta" })).await {
                Ok(v) => v.to_string(),
                Err(e) => json!({ "error": e.to_string() }).to_string(),
            }
        }

        "brave_search" => {
            let api_key = match brave_api_key {
                Some(k) => k,
                None => return json!({ "error": "BRAVE_API_KEY not set" }).to_string(),
            };
            let query = args
                .get("query")
                .and_then(|v| v.as_str())
                .unwrap_or("BTC price");
            let count = args
                .get("count")
                .and_then(|v| v.as_u64())
                .unwrap_or(5)
                .min(10);

            let encoded_query = urlencoding_simple(query);
            let url = format!(
                "https://api.search.brave.com/res/v1/web/search?q={}&count={}",
                encoded_query, count
            );

            match client
                .get(&url)
                .header("X-Subscription-Token", api_key)
                .header("Accept", "application/json")
                .send()
                .await
            {
                Ok(res) => match res.json::<Value>().await {
                    Ok(data) => {
                        let results: Vec<Value> = data["web"]["results"]
                            .as_array()
                            .unwrap_or(&vec![])
                            .iter()
                            .map(|r| {
                                json!({
                                    "title": r["title"],
                                    "description": r["description"],
                                    "url": r["url"]
                                })
                            })
                            .collect();
                        json!(results).to_string()
                    }
                    Err(e) => json!({ "error": e.to_string() }).to_string(),
                },
                Err(e) => json!({ "error": e.to_string() }).to_string(),
            }
        }

        _ => json!({ "error": format!("Unknown tool: {}", name) }).to_string(),
    }
}

fn urlencoding_simple(s: &str) -> String {
    let mut encoded = String::new();
    for c in s.chars() {
        match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => encoded.push(c),
            ' ' => encoded.push('+'),
            _ => {
                for byte in c.to_string().as_bytes() {
                    encoded.push_str(&format!("%{:02X}", byte));
                }
            }
        }
    }
    encoded
}
