#!/usr/bin/env bash
# Build target/strata_<version>_<arch>.deb from the self-contained binary (`make bundled`).
# The library Depends come from dpkg-shlibdeps on that binary, so the glibc floor follows
# whatever machine built it.
set -euo pipefail
umask 022
cd "$(dirname "$0")/.."

bin=target/strata-bundled
[ -x "$bin" ] || { echo "missing $bin: run make bundled first" >&2; exit 1; }
version=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
arch=$(dpkg --print-architecture)
root=$PWD/target/deb/strata
out=target/strata_${version}_${arch}.deb

rm -rf target/deb
mkdir -p "$root/DEBIAN" "$root/usr/bin" "$root/usr/share/doc/strata"
install -m755 "$bin" "$root/usr/bin/strata"
install -m644 README.md "$root/usr/share/doc/strata/README.md"
# The app launcher entry; desktop-file-utils and hicolor-icon-theme refresh their caches by trigger.
install -Dm644 packaging/strata.desktop "$root/usr/share/applications/strata.desktop"
install -Dm644 packaging/strata.svg "$root/usr/share/icons/hicolor/scalable/apps/strata.svg"

# dpkg-shlibdeps insists on a debian/control in its working directory.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/debian"
printf 'Source: strata\n\nPackage: strata\nArchitecture: any\n' > "$work/debian/control"
shlibs=$(cd "$work" && dpkg-shlibdeps -O "$root/usr/bin/strata" 2>/dev/null | sed -n 's/^shlibs:Depends=//p')
[ -n "$shlibs" ] || { echo "dpkg-shlibdeps found no dependencies" >&2; exit 1; }

cat > "$root/DEBIAN/control" <<EOF
Package: strata
Version: $version
Architecture: $arch
Maintainer: Federico <federicoquo@gmail.com>
Installed-Size: $(du -sk --apparent-size "$root/usr" | cut -f1)
Depends: $shlibs, git
Suggests: ffmpeg, chromium | google-chrome-stable | firefox
Section: devel
Priority: optional
Homepage: https://github.com/MrSeal04/strata
Description: see how a git repository grew
 strata reads a repository's history, measures every commit's additions and
 deletions, tracks which commit and author wrote every surviving line, and plays
 the history back in a browser dashboard: an evolving treemap, a file tree, a
 stacked area chart and per-commit bars on one timeline.
 .
 DuckDB is compiled into the binary. Headless video export (strata render)
 also needs ffmpeg and Chrome, Chromium or Firefox.
EOF

dpkg-deb --root-owner-group -Zxz --build "$root" "$out" >/dev/null
echo "built $out"
dpkg-deb --field "$out" Version Depends
