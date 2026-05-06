use std::env;

#[derive(Debug, Clone)]
pub struct Config {
    pub openrouter_api_key: String,
    pub openrouter_model: String,
    pub hl_wallet: String,
    pub hl_private_key: String,
    pub hl_master: String,
    /// The effective account to query (master if set, else wallet)
    pub hl_account: String,
    pub brave_api_key: Option<String>,
    pub port: u16,
    pub next_public_hl_master: String,
}

impl Config {
    pub fn from_env() -> Self {
        let hl_wallet = env::var("HYPERLIQUID_WALLET_ADDRESS").unwrap_or_default();
        let hl_master = env::var("HYPERLIQUID_MASTER_ADDRESS")
            .or_else(|_| env::var("NEXT_PUBLIC_HL_MASTER"))
            .unwrap_or_default();
        let next_public_hl_master = env::var("NEXT_PUBLIC_HL_MASTER")
            .unwrap_or_else(|_| hl_master.clone());

        let is_agent = !hl_master.is_empty()
            && hl_master.to_lowercase() != hl_wallet.to_lowercase();
        let hl_account = if is_agent {
            hl_master.clone()
        } else {
            hl_wallet.clone()
        };

        let port = env::var("PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(3001);

        Config {
            openrouter_api_key: env::var("OPENROUTER_API_KEY").unwrap_or_default(),
            openrouter_model: env::var("OPENROUTER_MODEL")
                .unwrap_or_else(|_| "qwen/qwen3-235b-a22b".to_string()),
            hl_wallet,
            hl_private_key: env::var("HYPERLIQUID_PRIVATE_KEY").unwrap_or_default(),
            hl_master,
            hl_account,
            brave_api_key: env::var("BRAVE_API_KEY").ok().filter(|k| !k.is_empty()),
            port,
            next_public_hl_master,
        }
    }

    pub fn has_signing_key(&self) -> bool {
        !self.hl_private_key.is_empty()
    }
}
