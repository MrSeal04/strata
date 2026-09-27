//! `strata render`: headless video export (implemented with the export milestone).

use clap::Args;
use strata_store::Layout;

#[derive(Args)]
pub struct RenderArgs {
    /// Repo id (see `strata list`) or source
    pub repo: String,
}

pub fn run(_layout: Layout, _args: RenderArgs) -> anyhow::Result<()> {
    anyhow::bail!("`strata render` is not implemented yet")
}
