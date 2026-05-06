use std::sync::Arc;
use dashmap::DashMap;
use tokio_util::sync::CancellationToken;
use crate::config::Config;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub cancel_tokens: Arc<DashMap<String, CancellationToken>>,
}

impl AppState {
    pub fn new(config: Config) -> Self {
        Self {
            config: Arc::new(config),
            cancel_tokens: Arc::new(DashMap::new()),
        }
    }
}
