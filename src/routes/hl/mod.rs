mod price;
mod account;
mod orderbook;
mod candles;
mod place_order;
mod close_position;

use axum::Router;
use axum::routing::{get, post};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/price",          get(price::price_handler))
        .route("/account",        get(account::account_handler))
        .route("/orderbook",      get(orderbook::orderbook_handler))
        .route("/candles",        get(candles::candles_handler))
        .route("/place-order",    post(place_order::place_order_handler))
        .route("/close-position", post(close_position::close_position_handler))
}
