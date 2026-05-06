mod chat;
mod interrupt;
mod threads;
mod history;

use axum::Router;
use axum::routing::{get, post};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/chat",      post(chat::chat_handler))
        .route("/interrupt", post(interrupt::interrupt_handler))
        .route("/threads",   get(threads::threads_handler).delete(threads::delete_thread_handler))
        .route("/history",   get(history::history_handler))
}
