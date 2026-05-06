pub mod market;
pub mod signing;

pub const HL_API: &str = "https://api.hyperliquid.xyz";
pub const HL_LEVERAGE: u32 = 5;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HLPosition {
    pub side: String,        // "long" | "short"
    pub size_btc: f64,
    pub entry_px: f64,
    pub unrealized_pnl: f64,
    pub leverage: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HLAccount {
    pub equity: f64,
    pub spot_usdc: f64,
    pub total_equity: f64,
    pub total_ntl: f64,
    pub position: Option<HLPosition>,
}
