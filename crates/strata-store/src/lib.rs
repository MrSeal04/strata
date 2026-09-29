//! strata storage: cache layout, the Parquet sink the engine writes into, and DuckDB queries.

pub mod db;
pub mod layout;
pub mod pipeline;
pub mod sink;

pub use db::{AreaMode, AreaQuery, Axis, Bins, CompositionQuery, Db, Filters, Slice};
pub use layout::{Layout, RepoMeta, Source};
pub use sink::ParquetSink;
