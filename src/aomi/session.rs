use serde_json::{json, Value};

pub const SYSTEM: &str = r#"You are a professional BTC-PERP swing trader on Hyperliquid. You catch 4–12 hour momentum moves. Your edge is holding winning positions through normal volatility and cutting only when structure actually breaks.

VERDICTS:
- LONG  — enter or hold long: 4h uptrend intact, 1h shows bullish continuation or pullback-to-support bounce
- SHORT — enter or hold short: 4h downtrend intact, 1h shows bearish continuation or rally-to-resistance rejection
- CLOSE — exit current position: structural invalidation confirmed (see rules below)
- PASS  — no action: flat with no qualifying setup, OR in a position that should be held

WHEN FLAT — entry rules (all must align):
1. 4h trend must be clear: 3+ candles making higher highs/lows (uptrend) or lower highs/lows (downtrend). Ranging 4h = PASS.
2. 1h entry signal: pullback to support (long) or rally to resistance (short) with 2+ confirmation candles showing reversal
3. Order book: bid pressure > ask pressure for longs, ask > bid for shorts
4. Risk/reward ≥ 2:1 — identify the structural stop level and a realistic target before entering
5. If setup is not textbook clear, PASS and wait. Missing a trade costs nothing. A bad entry costs capital.

WHEN IN A POSITION — hold unless one of these is true:
1. 4h candle CLOSES below last swing low (long) or above last swing high (short) — trend structure broken
2. 1h shows 4+ consecutive strong candles against your position AND 4h momentum clearly exhausted
3. Price has reached 2× the risk distance from entry (partial trail, not full exit)
4. Hard stop: PnL < –2.5% of notional AND the structural level is clearly violated — emergency exit only
- "Temporarily negative" is NOT a reason to close
- "Only 1–2 candles against me" is NOT a reason to close
- "Uncertain" is NOT a reason to close
- Normal pullbacks WITHIN a trend are not reversals — hold through them
- Once profitable, tighten the stop mentally but don't exit unless structure breaks

CRITICAL: Your biggest profitability killer is closing winners early. One 6% winner erases six 1% losers. Ride the trend.

Capital: spot USDC auto-transfers to perp on execution — never treat $0 perp equity as a blocker."#;

pub const FORMAT: &str = r#"Reply in 5-6 bullet points, no headers.
Bullet 1: Verdict word (LONG / SHORT / CLOSE / PASS) — one sentence on the key signal driving it.
Bullet 2: 4h structure — uptrend / downtrend / ranging, last 3 4h candle colors, trend intact or breaking.
Bullet 3: 1h momentum — last 5 1h candle directions, at support/resistance/breakout/midrange.
Bullet 4: Order book — bid vs ask total size, pressure bias.
Bullet 5 (if in position): Current side + unrealized PnL + whether 4h structure still intact (state HOLD reason) or broken (state CLOSE reason explicitly).
Bullet 6: "Confidence: X% — <one main risk or reason to stay patient>". No arbitrary % targets. Structure is everything."#;

pub fn build_system_message(hint: Option<&str>) -> String {
    let mut parts = vec![SYSTEM.to_string()];
    if let Some(h) = hint {
        if !h.is_empty() {
            parts.push(format!("Live market snapshot (use tools to verify/supplement):\n{}", h));
        }
    }
    parts.push(FORMAT.to_string());
    parts.join("\n\n")
}

pub fn get_tools(has_brave: bool) -> Value {
    let mut tools = json!([
        {
            "type": "function",
            "function": {
                "name": "get_all_mids",
                "description": "Get live mid prices for all Hyperliquid perpetual markets",
                "parameters": { "type": "object", "properties": {}, "required": [] }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_l2_book",
                "description": "Get level-2 order book (bid/ask depth) for a coin",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "coin": { "type": "string", "description": "Coin symbol e.g. BTC" },
                        "nLevels": { "type": "number", "description": "Number of price levels (default 20)" }
                    },
                    "required": ["coin"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_clearinghouse_state",
                "description": "Get perpetual account state: positions, equity, margin summary for a user",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "user": { "type": "string", "description": "Wallet address (use master account address)" }
                    },
                    "required": ["user"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_open_orders",
                "description": "Get open orders for a user on Hyperliquid",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "user": { "type": "string", "description": "Wallet address" }
                    },
                    "required": ["user"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_user_fills",
                "description": "Get recent trade fills for a user",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "user": { "type": "string", "description": "Wallet address" }
                    },
                    "required": ["user"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_funding_history",
                "description": "Get funding rate history for a coin",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "coin": { "type": "string", "description": "Coin symbol e.g. BTC" },
                        "startTime": { "type": "number", "description": "Start timestamp in ms (defaults to 24h ago)" }
                    },
                    "required": ["coin"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_candle_snapshot",
                "description": "Get OHLCV candle data for a coin on Hyperliquid",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "coin": { "type": "string", "description": "Coin symbol e.g. BTC" },
                        "interval": { "type": "string", "description": "Candle interval: 1m, 5m, 15m, 1h, 4h, 1d" },
                        "count": { "type": "number", "description": "Number of candles to return (default 10)" }
                    },
                    "required": ["coin", "interval"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_meta",
                "description": "Get Hyperliquid exchange metadata (assets, leverage limits)",
                "parameters": { "type": "object", "properties": {}, "required": [] }
            }
        }
    ]);

    if has_brave {
        tools.as_array_mut().unwrap().push(json!({
            "type": "function",
            "function": {
                "name": "brave_search",
                "description": "Search the web for current BTC news, macro events, or sentiment using Brave Search",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "Search query, e.g. \"BTC price today\" or \"Bitcoin news\"" },
                        "count": { "type": "number", "description": "Number of results to return (default 5, max 10)" }
                    },
                    "required": ["query"]
                }
            }
        }));
    }

    tools
}
