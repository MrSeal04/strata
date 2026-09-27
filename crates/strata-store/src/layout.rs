//! On-disk layout: `~/.cache/strata/` holds `clones/` (mirrors of remote repos) and one
//! directory per analyzed repo with Parquet parts, the engine checkpoint and `meta.json`.

use std::path::{Path, PathBuf};

use anyhow::Context;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const TABLES: &[&str] = &[
    "steps",
    "changes",
    "origin_deltas",
    "side_commits",
    "keyframes",
];

#[derive(Clone, Debug)]
pub struct Layout {
    pub root: PathBuf,
}

/// Where a repo came from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Source {
    Path { path: PathBuf },
    Url { url: String },
}

impl Source {
    /// A local directory if one exists at `s`, otherwise a git URL.
    pub fn parse(s: &str) -> anyhow::Result<Self> {
        let p = Path::new(s);
        if p.exists() {
            let path = p.canonicalize().with_context(|| format!("resolving {s}"))?;
            return Ok(Source::Path { path });
        }
        let looks_remote = s.contains("://") || (s.contains('@') && s.contains(':'));
        anyhow::ensure!(looks_remote, "{s}: not a directory or a git URL");
        Ok(Source::Url {
            url: s.trim_end_matches('/').to_string(),
        })
    }

    /// Short human name: the directory or repository name.
    pub fn name(&self) -> String {
        let raw = match self {
            Source::Path { path } => path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            Source::Url { url } => url.rsplit(['/', ':']).next().unwrap_or(url).to_string(),
        };
        raw.trim_end_matches(".git").to_string()
    }

    /// Stable id used for the cache directory: `<name>-<8 hex of sha256(source)>`.
    pub fn id(&self) -> String {
        let key = match self {
            Source::Path { path } => format!("path:{}", path.display()),
            Source::Url { url } => format!("url:{}", url.trim_end_matches(".git")),
        };
        let digest = Sha256::digest(key.as_bytes());
        let hex: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();
        let name: String = self
            .name()
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        format!("{name}-{hex}")
    }
}

/// Written after every successful extraction; the server's repo list comes from these.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RepoMeta {
    pub id: String,
    pub name: String,
    pub source: Source,
    /// The git directory actually read (the clone mirror for URLs).
    pub git_dir: PathBuf,
    pub branch: String,
    pub head: String,
    pub steps: u32,
    pub first_time: i64,
    pub last_time: i64,
    pub engine_version: String,
    pub updated_at: i64,
    pub last_run: serde_json::Value,
}

impl Layout {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    /// `$STRATA_HOME`, else `$XDG_CACHE_HOME/strata` / `~/.cache/strata`.
    pub fn default_root() -> PathBuf {
        if let Some(h) = std::env::var_os("STRATA_HOME") {
            return PathBuf::from(h);
        }
        dirs::cache_dir()
            .unwrap_or_else(|| PathBuf::from(".cache"))
            .join("strata")
    }

    pub fn repos_dir(&self) -> PathBuf {
        self.root.join("repos")
    }

    pub fn repo_dir(&self, id: &str) -> PathBuf {
        self.repos_dir().join(id)
    }

    /// Mirror clone location for a URL: `clones/<host>/<path>.git`.
    pub fn clone_dir(&self, url: &str) -> PathBuf {
        let stripped = url.split_once("://").map_or(url, |(_, rest)| rest);
        let stripped = stripped.rsplit_once('@').map_or(stripped, |(_, rest)| rest);
        let clean: String = stripped
            .trim_end_matches(".git")
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || "-_./".contains(c) {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        self.root
            .join("clones")
            .join(format!("{}.git", clean.replace("..", "_")))
    }

    pub fn read_meta(&self, id: &str) -> anyhow::Result<RepoMeta> {
        let path = self.repo_dir(id).join("meta.json");
        let text = std::fs::read_to_string(&path)
            .with_context(|| format!("reading {}", path.display()))?;
        Ok(serde_json::from_str(&text)?)
    }

    pub fn write_meta(&self, meta: &RepoMeta) -> anyhow::Result<()> {
        let dir = self.repo_dir(&meta.id);
        std::fs::create_dir_all(&dir)?;
        let tmp = dir.join("meta.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(meta)?)?;
        std::fs::rename(tmp, dir.join("meta.json"))?;
        Ok(())
    }

    /// All repos with a readable `meta.json`, most recently updated first.
    pub fn list(&self) -> Vec<RepoMeta> {
        let mut out: Vec<RepoMeta> = std::fs::read_dir(self.repos_dir())
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| self.read_meta(&e.file_name().to_string_lossy()).ok())
            .collect();
        out.sort_by_key(|m| std::cmp::Reverse(m.updated_at));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_ids_and_clone_dirs() {
        let s = Source::parse("https://github.com/torvalds/linux.git").unwrap();
        assert_eq!(s.name(), "linux");
        assert!(s.id().starts_with("linux-"));
        assert_eq!(
            s.id(),
            Source::parse("https://github.com/torvalds/linux")
                .unwrap()
                .id()
        );
        let l = Layout::new("/c".into());
        assert_eq!(
            l.clone_dir("https://github.com/torvalds/linux"),
            PathBuf::from("/c/clones/github.com/torvalds/linux.git")
        );
        assert_eq!(
            l.clone_dir("ssh://git@git.example.com:2222/you/project.git"),
            PathBuf::from("/c/clones/git.example.com_2222/you/project.git")
        );
        assert_eq!(Source::parse("git@github.com:a/b.git").unwrap().name(), "b");
        assert!(Source::parse("/definitely/not/here").is_err());
    }
}
