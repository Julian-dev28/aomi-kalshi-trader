use std::sync::Arc;
use dashmap::DashMap;
use tokio_util::sync::CancellationToken;
use crate::config::Config;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub cancel_tokens: Arc<DashMap<String, CancellationToken>>,
    pub http: Arc<reqwest::Client>,
}

impl AppState {
    pub fn new(config: Config) -> Self {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("failed to build reqwest client");
        Self {
            config: Arc::new(config),
            cancel_tokens: Arc::new(DashMap::new()),
            http: Arc::new(http),
        }
    }
}
