//! Per-repo configuration: `.strata.toml` in the repo, or `strata.toml` in its cache dir.
//!
//! ```toml
//! branch = "main"
//!
//! [identities]
//! merge = [["jane@old.example", "Jane Doe"]]   # names or emails that are one person
//! no_merge = ["build@ci.example"]              # never auto-merge these
//! bots = ["deploy@ci.example"]
//! humans = ["renovate-human@example.com"]      # overrides bot detection
//!
//! [classify]                                   # glob -> category name
//! "docs/generated/**" = "generated"
//! "testdata/**" = "data"
//! ```

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::Context;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct RepoConfig {
    pub branch: Option<String>,
    pub identities: IdentityConfig,
    pub classify: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct IdentityConfig {
    pub merge: Vec<Vec<String>>,
    pub no_merge: Vec<String>,
    pub bots: Vec<String>,
    pub humans: Vec<String>,
}

impl RepoConfig {
    /// Load the first config that exists; a missing file is not an error, a malformed one is.
    pub fn load(candidates: &[&Path]) -> anyhow::Result<Self> {
        for path in candidates {
            if path.is_file() {
                let text = std::fs::read_to_string(path)?;
                return toml::from_str(&text).with_context(|| format!("parsing {}", path.display()));
            }
        }
        Ok(Self::default())
    }
}
