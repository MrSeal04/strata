//! Author identities: `.mailmap`, then union-find auto-merging and bot flags.
//!
//! Rows store *raw* ids (one per distinct mailmapped name+email) so the merge heuristics and
//! per-repo overrides can change without re-extracting; `finalize` maps raw ids to canonical ones.

use bstr::{BStr, ByteSlice};
use regex::Regex;
use rustc_hash::FxHashMap;
use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;

use crate::config::IdentityConfig;
use crate::model::{AuthorId, AuthorRow};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RawIdentity {
    pub name: String,
    pub email: String,
    pub commits: u32,
}

pub struct Identities {
    mailmap: gix::mailmap::Snapshot,
    by_key: FxHashMap<(String, String), AuthorId>,
    raw: Vec<RawIdentity>,
}

impl Identities {
    pub fn new(mailmap: gix::mailmap::Snapshot, raw: Vec<RawIdentity>) -> Self {
        let by_key = raw
            .iter()
            .enumerate()
            .map(|(i, r)| ((r.name.clone(), r.email.to_lowercase()), i as AuthorId))
            .collect();
        Self {
            mailmap,
            by_key,
            raw,
        }
    }

    pub fn raw(&self) -> &[RawIdentity] {
        &self.raw
    }

    /// Map a commit signature to a raw identity id, applying `.mailmap` first.
    /// `count` says whether this sighting is a commit to tally (authors yes, committers no).
    pub fn resolve(&mut self, sig: gix::actor::SignatureRef<'_>, count: bool) -> AuthorId {
        let resolved = self.mailmap.try_resolve_ref(sig);
        let name: &BStr = resolved.as_ref().and_then(|r| r.name).unwrap_or(sig.name);
        let email: &BStr = resolved.as_ref().and_then(|r| r.email).unwrap_or(sig.email);
        let name = name.trim().to_str_lossy().into_owned();
        let email = email.trim().to_str_lossy().into_owned();
        let key = (name, email.to_lowercase());
        let id = match self.by_key.get(&key) {
            Some(&id) => id,
            None => {
                let id = self.raw.len() as AuthorId;
                self.raw.push(RawIdentity {
                    name: key.0.clone(),
                    email,
                    commits: 0,
                });
                self.by_key.insert(key, id);
                id
            }
        };
        if count {
            self.raw[id as usize].commits += 1;
        }
        id
    }

    /// Canonical grouping of raw identities (see module docs).
    pub fn finalize(&self, cfg: &IdentityConfig) -> Vec<AuthorRow> {
        finalize(&self.raw, cfg)
    }
}

const GENERIC_NAMES: &[&str] = &[
    "root",
    "unknown",
    "admin",
    "administrator",
    "user",
    "ubuntu",
    "debian",
    "localhost",
    "none",
    "nobody",
    "your name",
    "github",
    "git",
    "test",
    "dev",
    "developer",
];

const BOT_PATTERNS: &str = r"(?i)(\[bot\]|^dependabot|^renovate|^github-actions|^pre-commit-ci|^greenkeeper|^snyk-bot|^weblate|semantic-release-bot|^allcontributors|^imgbot|^codecov|^mergify|^copilot-swe-agent|^gitlab-bot|^forgejo-actions|^mend bolt|^deepsource-autofix|^autofix-ci|^transifex|^crowdin|^translate-bot|noreply\+bot)";

fn normalized_name(name: &str) -> Option<String> {
    let folded: String = name
        .nfkd()
        .filter(|c| !unicode_normalization::char::is_combining_mark(*c))
        .flat_map(char::to_lowercase)
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect();
    let tokens: Vec<&str> = folded.split_whitespace().collect();
    let joined = tokens.join(" ");
    (tokens.len() >= 2 && !GENERIC_NAMES.contains(&joined.as_str())).then_some(joined)
}

fn email_key(email: &str) -> Option<String> {
    let e = email.trim().to_lowercase();
    if e.is_empty() || !e.contains('@') || e.starts_with("none@") || e == "unknown@unknown" {
        return None;
    }
    // 12345+handle@users.noreply.github.com and handle@users.noreply.github.com -> gh:handle
    if let Some(local) = e.strip_suffix("@users.noreply.github.com") {
        let handle = local.split_once('+').map_or(local, |(_, h)| h);
        return Some(format!("gh:{handle}"));
    }
    Some(e)
}

fn find(parent: &mut [usize], mut x: usize) -> usize {
    while parent[x] != x {
        parent[x] = parent[parent[x]];
        x = parent[x];
    }
    x
}

fn union(parent: &mut [usize], a: usize, b: usize) {
    let (ra, rb) = (find(parent, a), find(parent, b));
    if ra != rb {
        parent[ra.max(rb)] = ra.min(rb);
    }
}

pub fn finalize(raw: &[RawIdentity], cfg: &IdentityConfig) -> Vec<AuthorRow> {
    let n = raw.len();
    let mut parent: Vec<usize> = (0..n).collect();
    let no_merge = |r: &RawIdentity| {
        cfg.no_merge
            .iter()
            .any(|k| k.eq_ignore_ascii_case(&r.email) || k == &r.name)
    };

    let mut first_by_key: FxHashMap<String, usize> = FxHashMap::default();
    for (i, r) in raw.iter().enumerate() {
        if no_merge(r) {
            continue;
        }
        let keys = [
            email_key(&r.email),
            normalized_name(&r.name).map(|n| format!("name:{n}")),
        ];
        for key in keys.into_iter().flatten() {
            match first_by_key.get(&key) {
                Some(&j) => union(&mut parent, i, j),
                None => {
                    first_by_key.insert(key, i);
                }
            }
        }
    }
    // Explicit merges: each group lists names or emails that are one person.
    for group in &cfg.merge {
        let members: Vec<usize> = raw
            .iter()
            .enumerate()
            .filter(|(_, r)| {
                group
                    .iter()
                    .any(|k| k.eq_ignore_ascii_case(&r.email) || k == &r.name)
            })
            .map(|(i, _)| i)
            .collect();
        for w in members.windows(2) {
            union(&mut parent, w[0], w[1]);
        }
    }

    // Canonical representative = the member with the most commits (ties: lowest id).
    let mut best: FxHashMap<usize, usize> = FxHashMap::default();
    for i in 0..n {
        let root = find(&mut parent, i);
        let e = best.entry(root).or_insert(i);
        if raw[i].commits > raw[*e].commits {
            *e = i;
        }
    }

    let bot_re = Regex::new(BOT_PATTERNS).expect("bot regex");
    raw.iter()
        .enumerate()
        .map(|(i, r)| {
            let root = find(&mut parent, i);
            let canon = best[&root];
            let listed = |list: &[String]| {
                list.iter()
                    .any(|k| k.eq_ignore_ascii_case(&r.email) || k == &r.name)
            };
            let is_bot = if listed(&cfg.humans) {
                false
            } else {
                listed(&cfg.bots) || bot_re.is_match(&r.name) || bot_re.is_match(&r.email)
            };
            AuthorRow {
                author_id: i as AuthorId,
                canonical_id: canon as AuthorId,
                name: r.name.clone(),
                email: r.email.clone(),
                is_bot,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(name: &str, email: &str, commits: u32) -> RawIdentity {
        RawIdentity {
            name: name.into(),
            email: email.into(),
            commits,
        }
    }

    #[test]
    fn merges_by_email_name_and_github_noreply() {
        let ids = vec![
            raw("Jane Doe", "jane@work.example", 10),
            raw("jane", "JANE@work.example", 1),
            raw("Jane Dóe", "jane@home.example", 3),
            raw("Octo Cat", "1234+octocat@users.noreply.github.com", 2),
            raw("octocat", "octocat@users.noreply.github.com", 1),
            raw("root", "root@localhost", 1),
            raw("root", "root@otherhost", 1),
            raw(
                "dependabot[bot]",
                "49699333+dependabot[bot]@users.noreply.github.com",
                5,
            ),
        ];
        let rows = finalize(&ids, &IdentityConfig::default());
        let canon: Vec<u32> = rows.iter().map(|r| r.canonical_id).collect();
        assert_eq!(&canon[..3], &[0, 0, 0], "email + accent-folded name merge");
        assert_eq!(canon[3], canon[4], "github noreply forms merge");
        assert_ne!(
            canon[5], canon[6],
            "generic single-token names never merge by name"
        );
        assert!(rows[7].is_bot && !rows[0].is_bot);
    }

    #[test]
    fn config_overrides() {
        let ids = vec![
            raw("A Person", "a@x", 1),
            raw("Other Name", "b@y", 1),
            raw("ci", "ci@x", 1),
        ];
        let cfg = IdentityConfig {
            merge: vec![vec!["a@x".into(), "Other Name".into()]],
            bots: vec!["ci@x".into()],
            ..Default::default()
        };
        let rows = finalize(&ids, &cfg);
        assert_eq!(rows[0].canonical_id, rows[1].canonical_id);
        assert!(rows[2].is_bot);
    }
}
