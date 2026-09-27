//! Path classification: language (linguist tables) and category (source, docs, vendored, ...).
//!
//! Categories are stored per path and applied as query-time filters, so nothing here affects the
//! extracted history itself. `.gitattributes` rules come from the tip commit's tree.

use globset::{GlobBuilder, GlobMatcher};
use regex::{Regex, RegexSet};

use crate::config::RepoConfig;
use crate::langs_table::{EXTENSIONS, FILENAMES, LANGS, VENDOR_PATTERNS};
use crate::model::category::{self, NAMES};

/// Facts about a path learned while diffing its contents.
#[derive(Clone, Copy, Debug, Default)]
pub struct PathFacts {
    pub binary: bool,
    pub submodule: bool,
    pub generated_hint: bool,
}

pub fn language(path: &str) -> Option<u16> {
    let file = path.rsplit('/').next().unwrap_or(path);
    if let Ok(i) = FILENAMES.binary_search_by(|(n, _)| (*n).cmp(file)) {
        return Some(FILENAMES[i].1);
    }
    let dot = file.rfind('.').filter(|&i| i > 0)?;
    let ext = file[dot..].to_ascii_lowercase();
    EXTENSIONS
        .binary_search_by(|(e, _)| (*e).cmp(ext.as_str()))
        .ok()
        .map(|i| EXTENSIONS[i].1)
}

pub fn lang_name(idx: Option<u16>) -> &'static str {
    idx.map_or("Other", |i| LANGS[i as usize].0)
}

pub fn lang_color(name: &str) -> Option<&'static str> {
    LANGS
        .iter()
        .find(|(n, _, _)| *n == name)
        .map(|(_, c, _)| *c)
        .filter(|c| !c.is_empty())
}

const LOCKFILES: &[&str] = &[
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lock",
    "bun.lockb",
    "Cargo.lock",
    "uv.lock",
    "poetry.lock",
    "Pipfile.lock",
    "pdm.lock",
    "pixi.lock",
    "conda-lock.yml",
    "composer.lock",
    "Gemfile.lock",
    "go.sum",
    "go.work.sum",
    "flake.lock",
    "mix.lock",
    "pubspec.lock",
    "Podfile.lock",
    "Package.resolved",
    "packages.lock.json",
    "gradle.lockfile",
    "deno.lock",
    ".terraform.lock.hcl",
    "Manifest.toml",
    "shard.lock",
    "rebar.lock",
    "cabal.project.freeze",
    "stack.yaml.lock",
    "yarn-offline-mirror",
    "berksfile.lock",
    "Chart.lock",
    "renv.lock",
];

/// linguist calls these "data", but they are hand-written configuration, not bulk data.
const CONFIG_LANGS: &[&str] = &[
    "YAML",
    "TOML",
    "INI",
    "Git Config",
    "Ignore List",
    "EditorConfig",
    "JSON with Comments",
    "Dotenv",
    "Git Attributes",
    "Nix",
    "HCL",
    "Dockerfile",
    "Makefile",
    "CMake",
    "Linker Script",
    "Kconfig",
    "Device Tree",
    "Protocol Buffer",
    "GraphQL",
    "SSH Config",
    "Nginx",
    "Apache Conf",
    "Starlark",
];

const GENERATED_PATTERNS: &[&str] = &[
    r"\.min\.(js|css|mjs)$",
    r"\.(js|css)\.map$",
    r"\.pb\.(go|cc|h)$",
    r"_pb2(_grpc)?\.pyi?$",
    r"\.designer\.(cs|vb)$",
    r"\.(g|freezed)\.dart$",
    r"(^|/)__generated__/",
    r"(^|/)dist/",
    r"(^|/)(Pods|Carthage/Build)/",
];

const DOCS_DIR: &str = r"(?i)(^|/)(docs?|documentation|man|examples?)/";

#[derive(Clone, Copy, Debug)]
enum Attr {
    Generated,
    Vendored,
    Documentation,
    Binary,
}

struct AttrRule {
    glob: GlobMatcher,
    effects: Vec<(Attr, Option<bool>)>,
}

pub struct Classifier {
    vendor: RegexSet,
    generated: RegexSet,
    docs_dir: Regex,
    attr_rules: Vec<AttrRule>,
    overrides: Vec<(GlobMatcher, u8)>,
}

fn glob(pattern: &str) -> Option<GlobMatcher> {
    GlobBuilder::new(pattern)
        .literal_separator(true)
        .build()
        .ok()
        .map(|g| g.compile_matcher())
}

/// Translate a gitattributes pattern in directory `dir` ("" or "a/b/") into a glob.
fn attr_glob(dir: &str, pattern: &str) -> Option<GlobMatcher> {
    if pattern.is_empty() || pattern.ends_with('/') || pattern.starts_with('!') {
        return None;
    }
    let full = if let Some(anchored) = pattern.strip_prefix('/') {
        format!("{dir}{anchored}")
    } else if pattern.contains('/') {
        format!("{dir}{pattern}")
    } else {
        format!("{dir}**/{pattern}")
    };
    glob(&full)
}

fn parse_attributes(dir: &str, content: &[u8], out: &mut Vec<AttrRule>) {
    for line in String::from_utf8_lossy(content).lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with('"') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let Some(pattern) = parts.next() else {
            continue;
        };
        let mut effects = Vec::new();
        for attr in parts {
            let (name, value) = if let Some(n) = attr.strip_prefix('-') {
                (n, Some(false))
            } else if let Some(n) = attr.strip_prefix('!') {
                (n, None)
            } else if let Some((n, v)) = attr.split_once('=') {
                (n, Some(!matches!(v, "false" | "0" | "no")))
            } else {
                (attr, Some(true))
            };
            let a = match name {
                "linguist-generated" => Attr::Generated,
                "linguist-vendored" => Attr::Vendored,
                "linguist-documentation" => Attr::Documentation,
                "binary" => Attr::Binary,
                // `-diff` makes git treat a file as binary (the `binary` macro implies it).
                "diff" if value == Some(false) => Attr::Binary,
                _ => continue,
            };
            let value = if name == "diff" { Some(true) } else { value };
            effects.push((a, value));
        }
        if !effects.is_empty()
            && let Some(glob) = attr_glob(dir, pattern)
        {
            out.push(AttrRule { glob, effects });
        }
    }
}

impl Classifier {
    /// `attr_files`: (directory prefix like "" or "sub/dir/", .gitattributes content), shallowest first.
    pub fn new(attr_files: &[(String, Vec<u8>)], cfg: &RepoConfig) -> Self {
        let valid: Vec<&str> = VENDOR_PATTERNS
            .iter()
            .copied()
            .filter(|p| Regex::new(p).is_ok())
            .collect();
        let mut attr_rules = Vec::new();
        for (dir, content) in attr_files {
            parse_attributes(dir, content, &mut attr_rules);
        }
        let overrides = cfg
            .classify
            .iter()
            .filter_map(|(pat, cat)| {
                let idx = NAMES.iter().position(|n| n.eq_ignore_ascii_case(cat))?;
                Some((glob(pat)?, idx as u8))
            })
            .collect();
        Self {
            vendor: RegexSet::new(valid).expect("vendor regexes validated"),
            generated: RegexSet::new(GENERATED_PATTERNS).expect("generated regexes"),
            docs_dir: Regex::new(DOCS_DIR).expect("docs regex"),
            attr_rules,
            overrides,
        }
    }

    fn attr(&self, path: &str, which: fn(Attr) -> bool) -> Option<bool> {
        let mut value = None;
        for rule in &self.attr_rules {
            if rule.glob.is_match(path) {
                for &(a, v) in &rule.effects {
                    if which(a) {
                        value = v;
                    }
                }
            }
        }
        value
    }

    /// (category, language index)
    pub fn classify(&self, path: &str, facts: PathFacts) -> (u8, Option<u16>) {
        let lang = language(path);
        if let Some((_, cat)) = self.overrides.iter().find(|(g, _)| g.is_match(path)) {
            return (*cat, lang);
        }
        if facts.submodule {
            return (category::SUBMODULE, lang);
        }
        let file = path.rsplit('/').next().unwrap_or(path);
        if self.attr(path, |a| matches!(a, Attr::Generated)) == Some(true) {
            return (category::GENERATED, lang);
        }
        if self.attr(path, |a| matches!(a, Attr::Vendored)) == Some(true) {
            return (category::VENDORED, lang);
        }
        if self.attr(path, |a| matches!(a, Attr::Documentation)) == Some(true) {
            return (category::DOCS, lang);
        }
        if facts.binary || self.attr(path, |a| matches!(a, Attr::Binary)) == Some(true) {
            return (category::BINARY, lang);
        }
        if LOCKFILES.contains(&file) {
            return (category::LOCKFILE, lang);
        }
        if facts.generated_hint || self.generated.is_match(path) {
            return (category::GENERATED, lang);
        }
        if self.vendor.is_match(path) {
            return (category::VENDORED, lang);
        }
        let name = lang_name(lang);
        if name == "Jupyter Notebook" {
            return (category::NOTEBOOK, lang);
        }
        let ty = lang.map(|i| LANGS[i as usize].2);
        if ty == Some(3) || (ty == Some(1) && self.docs_dir.is_match(path)) {
            return (category::DOCS, lang);
        }
        if ty == Some(2) && !CONFIG_LANGS.contains(&name) {
            return (category::DATA, lang);
        }
        (category::SOURCE, lang)
    }
}

/// Cheap content sniff for "this file is generated" markers near the top of a file.
pub fn looks_generated(head: &[u8]) -> bool {
    let head = &head[..head.len().min(1024)];
    let lower = head.to_ascii_lowercase();
    [
        &b"do not edit"[..],
        b"@generated",
        b"code generated",
        b"autogenerated",
        b"auto-generated",
    ]
    .iter()
    .any(|needle| memchr_find(&lower, needle))
}

fn memchr_find(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cat(c: &Classifier, path: &str) -> &'static str {
        NAMES[c.classify(path, PathFacts::default()).0 as usize]
    }

    #[test]
    fn categories_and_languages() {
        let attrs = vec![
            (
                String::new(),
                b"*.gen.ts linguist-generated\nthird_party/** linguist-vendored\n".to_vec(),
            ),
            ("web/".to_string(), b"fixtures/** -diff\n".to_vec()),
        ];
        let mut cfg = RepoConfig::default();
        cfg.classify.insert("testdata/**".into(), "data".into());
        let c = Classifier::new(&attrs, &cfg);
        assert_eq!(cat(&c, "src/main.rs"), "source");
        assert_eq!(cat(&c, "Cargo.lock"), "lockfile");
        assert_eq!(cat(&c, "web/uv.lock"), "lockfile");
        assert_eq!(cat(&c, "node_modules/x/index.js"), "vendored");
        assert_eq!(cat(&c, "third_party/lib/a.c"), "vendored");
        assert_eq!(cat(&c, "api/client.gen.ts"), "generated");
        assert_eq!(cat(&c, "static/app.min.js"), "generated");
        assert_eq!(cat(&c, "web/fixtures/blob.txt"), "binary");
        assert_eq!(cat(&c, "README.md"), "docs");
        assert_eq!(cat(&c, "notes/a.ipynb"), "notebook");
        assert_eq!(cat(&c, "data/points.csv"), "data");
        assert_eq!(cat(&c, "config.yml"), "source");
        assert_eq!(cat(&c, "testdata/x.rs"), "data");
        assert_eq!(lang_name(language("src/lib.rs")), "Rust");
        assert_eq!(lang_name(language("Makefile")), "Makefile");
        assert_eq!(lang_name(language("include/linux/sched.h")), "C");
        assert_eq!(lang_name(language("LICENSE_NOEXT")), "Other");
        assert!(looks_generated(
            b"// Code generated by protoc-gen-go. DO NOT EDIT.\npackage x"
        ));
        assert!(!looks_generated(b"fn main() {}"));
    }
}
