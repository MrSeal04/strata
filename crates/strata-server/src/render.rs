//! Headless video rendering (frame sink for `strata render`). Filled in with the export milestone.

use std::sync::Arc;

use axum::Router;

use crate::AppState;

#[derive(Default)]
pub struct Renders {}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
}
