#!/usr/bin/env bash
# Build small deterministic git repos that exercise the extraction engine's edge cases.
# Usage: fixtures/make.sh [outdir]   (default: fixtures/out)
set -euo pipefail

OUT="${1:-$(cd "$(dirname "$0")" && pwd)/out}"
rm -rf "$OUT"
mkdir -p "$OUT"

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1
T0=1700000000 # 2023-11-14
N=0

# as <name> <email> <cmd...>: run a git command as that identity at the next fixed timestamp
as() {
  N=$((N + 1))
  local when=$((T0 + N * 86400 * 9))
  local name="$1" email="$2"
  shift 2
  (
    export GIT_AUTHOR_NAME="$name" GIT_AUTHOR_EMAIL="$email" GIT_AUTHOR_DATE="@$when +0000"
    export GIT_COMMITTER_NAME="$name" GIT_COMMITTER_EMAIL="$email" GIT_COMMITTER_DATE="@$when +0000"
    "$@"
  )
}

# commit "<message>" [author-name author-email]
commit() {
  git add -A
  as "${2:-Alice Example}" "${3:-alice@example.com}" git commit -q --allow-empty -m "$1"
}

# merge <branch...> "<message>" [extra git-merge args...]; conflicts are left for the caller
merge() {
  local branch="$1" msg="$2"
  shift 2
  # shellcheck disable=SC2086
  as "Maintainer Mo" "mo@example.com" git merge -q --no-ff "$@" -m "$msg" $branch || true
}

lines() { # lines <prefix> <count>
  for i in $(seq 1 "$2"); do echo "$1 line $i"; done
}

########################################################################
# linear: plain history, adds/modifies/deletes, a rename with edits.
mkdir "$OUT/linear" && cd "$OUT/linear"
git init -q -b main
mkdir -p src docs
lines alpha 10 > src/a.py
lines beta 5 > src/b.py
commit "initial import"
lines alpha 12 > src/a.py
echo "extra" >> src/b.py
commit "grow a and b"
lines gamma 7 > docs/guide.md
rm src/b.py
commit "add guide, drop b"
git mv src/a.py src/core.py
sed -i 's/alpha line 3/alpha line three/' src/core.py
commit "rename a -> core with an edit"
printf 'no newline at end' > src/tail.txt
commit "file without trailing newline"
git tag v1.0
sed -i 's/^alpha/  alpha/' src/core.py
commit "reindent core (whitespace only)"

########################################################################
# kitchen: merges, conflicts, octopus, subtree, binary, lockfile, vendored,
# submodule gitlink, mailmap aliases, bot commits, directory move.
mkdir "$OUT/kitchen" && cd "$OUT/kitchen"
git init -q -b main
mkdir -p app lib vendor/thing
lines app 20 > app/main.rs
lines lib 8 > lib/util.rs
lines vendored 50 > vendor/thing/thing.js
printf '[[package]]\nname = "x"\n' > Cargo.lock
printf 'Bob B <bob@example.com> <bob.old@example.com>\n' > .mailmap
printf 'lib/gen_*.rs linguist-generated\n' > .gitattributes
commit "initial import"

git checkout -q -b feature
lines feat 6 > app/feature.rs
commit "feature: add feature.rs" "Bob Old" "bob.old@example.com"
sed -i 's/app line 5/app line five (feature)/' app/main.rs
commit "feature: tweak main" "Bob B" "bob@example.com"
git checkout -q main
sed -i 's/app line 5/app line five (main)/' app/main.rs
commit "main: conflicting tweak"
merge feature "Merge feature (with conflict)"
# resolve the conflict by hand: keep both variants
lines app 20 | sed 's/app line 5$/app line five (main+feature)/' > app/main.rs
git add app/main.rs
as "Maintainer Mo" "mo@example.com" git commit -q --no-edit

printf '\x89PNG\r\n\x1a\n\x00\x00binarydata\x00' > app/logo.png
printf '[[package]]\nname = "x"\n[[package]]\nname = "y"\nversion = "2"\n' > Cargo.lock
commit "add logo, bump lockfile" "dependabot[bot]" "49699333+dependabot[bot]@users.noreply.github.com"

lines generated 30 > lib/gen_table.rs
mkdir -p deps/sub && git update-index --add --cacheinfo 160000,1111111111111111111111111111111111111111,deps/sub
commit "generated table + submodule"

# octopus merge of two small branches
git checkout -q -b o1
lines one 3 > o1.txt
commit "o1" "Carol C" "carol@example.com"
git checkout -q main
git checkout -q -b o2
lines two 4 > o2.txt
commit "o2" "Dan D" "dan@example.com"
git checkout -q main
merge "o1 o2" "Octopus merge o1 + o2"

# unrelated history merged as a subtree
git checkout -q --orphan other
git rm -rq --cached . && rm -rf app lib vendor Cargo.lock .mailmap .gitattributes o1.txt o2.txt logo.png deps 2>/dev/null || true
mkdir -p tool
lines tool 9 > tool/tool.sh
git add tool
commit "unrelated tool history" "Eve E" "eve@example.com"
git checkout -q -f main
merge other "Merge unrelated tool" --allow-unrelated-histories

git mv lib library
commit "move lib/ -> library/"
as "Alice Example" "alice@example.com" git tag -a v2.0 -m "release 2.0"
git rm -q vendor/thing/thing.js
commit "drop vendored thing"

echo "fixtures written to $OUT"
