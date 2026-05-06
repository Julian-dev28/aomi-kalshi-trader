#![allow(dead_code)]
mod aomi;
mod config;
mod hyperliquid;
mod routes;
mod state;

use std::net::SocketAddr;
use tracing::info;
use tracing_subscriber::EnvFilter;

use config::Config;
use state::AppState;

#[tokio::main]
async fn main() {
    // Load .env.local first, then .env
    let _ = dotenvy::from_filename(".env.local");
    let _ = dotenvy::dotenv();

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let config = Config::from_env();
    let port = config.port;

    if config.openrouter_api_key.is_empty() {
        tracing::warn!("OPENROUTER_API_KEY is not set — AI features will fail");
    }
    if config.hl_private_key.is_empty() {
        tracing::warn!("HYPERLIQUID_PRIVATE_KEY is not set — order placement will be disabled");
    }

    info!(
        model = %config.openrouter_model,
        hl_account = %config.hl_account,
        port = port,
        "Starting aomi-trader"
    );

    let state = AppState::new(config);
    let app = routes::build_router(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    info!("Listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
