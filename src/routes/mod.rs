pub mod aomi;
pub mod hl;
pub mod pages;

use axum::Router;
use tower_http::cors::{Any, CorsLayer};
use crate::state::AppState;

pub fn build_router(state: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        .merge(pages::router())
        .nest("/api/hl", hl::router())
        .nest("/api/aomi", aomi::router())
        .merge(static_assets_router())
        .layer(cors)
        .with_state(state)
}

fn static_assets_router() -> Router<AppState> {
    use axum::routing::get;
    use rust_embed::RustEmbed;
    use axum::response::IntoResponse;
    use axum::http::{header, StatusCode};

    #[derive(RustEmbed)]
    #[folder = "static/"]
    struct StaticAssets;

    async fn static_handler(
        axum::extract::Path(path): axum::extract::Path<String>,
    ) -> impl IntoResponse {
        match StaticAssets::get(&path) {
            Some(content) => {
                let mime = mime_guess(&path);
                (
                    StatusCode::OK,
                    [(header::CONTENT_TYPE, mime)],
                    content.data.into_owned(),
                )
                    .into_response()
            }
            None => StatusCode::NOT_FOUND.into_response(),
        }
    }

    Router::new().route("/static/*path", get(static_handler))
}

fn mime_guess(path: &str) -> &'static str {
    if path.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if path.ends_with(".js") {
        "application/javascript; charset=utf-8"
    } else if path.ends_with(".html") {
        "text/html; charset=utf-8"
    } else if path.ends_with(".svg") {
        "image/svg+xml"
    } else if path.ends_with(".png") {
        "image/png"
    } else if path.ends_with(".ico") {
        "image/x-icon"
    } else {
        "application/octet-stream"
    }
}
