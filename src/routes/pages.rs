use askama::Template;
use askama_axum::IntoResponse;
use axum::routing::get;
use axum::Router;
use crate::state::AppState;

#[derive(Template)]
#[template(path = "landing.html")]
struct LandingTemplate {}

#[derive(Template)]
#[template(path = "dashboard.html")]
struct DashboardTemplate {}

#[derive(Template)]
#[template(path = "agent.html")]
struct AgentTemplate {}

async fn landing() -> impl IntoResponse {
    LandingTemplate {}
}

async fn dashboard() -> impl IntoResponse {
    DashboardTemplate {}
}

async fn agent() -> impl IntoResponse {
    AgentTemplate {}
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", get(landing))
        .route("/dashboard", get(dashboard))
        .route("/agent", get(agent))
}
