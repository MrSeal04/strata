//! strata extraction engine: turns a git history into per-step change, survival and state rows.

pub mod blame;
pub mod classify;
pub mod config;
pub mod diff;
pub mod extract;
pub mod identity;
#[rustfmt::skip]
mod langs_table;
pub mod model;
pub mod time;
pub mod tracker;
pub mod walk;

pub use config::RepoConfig;
pub use extract::{ExtractOptions, ExtractReport, Progress, extract};
pub use model::Sink;
