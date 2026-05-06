use axum::extract::State;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::state::AppState;

#[derive(Deserialize)]
pub struct InterruptRequest {
    #[serde(rename = "sessionId")]
    pub session_id: Option<String>,
}

pub async fn interrupt_handler(
    State(state): State<AppState>,
    Json(body): Json<InterruptRequest>,
) -> Json<Value> {
    if let Some(session_id) = &body.session_id {
        if let Some(token) = state.cancel_tokens.get(session_id) {
            token.cancel();
        }
        state.cancel_tokens.remove(session_id);
    }
    Json(json!({ "ok": true }))
}
