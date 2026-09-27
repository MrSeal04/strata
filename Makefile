# strata: `make` builds everything, `make check` runs every test and lint.
PREFIX ?= $(HOME)/.local
CARGO  ?= cargo

.PHONY: all web build bundled check test smoke fixtures install dev clean

all: build

web/node_modules: web/package.json web/package-lock.json
	cd web && npm ci --no-audit --no-fund
	@touch $@

web: web/node_modules
	cd web && npm run build

# The release binary embeds web/dist, so build the web app first.
build: web
	$(CARGO) build --release
	@echo "built target/release/strata"

# Self-contained binary: DuckDB compiled from source and linked statically (slow).
bundled: web
	DUCKDB_DOWNLOAD_LIB=0 CARGO_BUILD_JOBS=$${CARGO_BUILD_JOBS:-3} $(CARGO) build --release -p strata-cli --features strata-store/bundled

check: web/node_modules
	$(CARGO) fmt --check
	$(CARGO) clippy --all-targets -- -D warnings
	$(CARGO) test
	cd web && npx tsc --noEmit && npx vitest run

test: check

# Headless dashboard smoke test on a fixture (needs Chrome/Chromium).
smoke: web
	$(CARGO) build
	node tools/smoke.mjs target/debug/strata

fixtures:
	fixtures/make.sh

# Installs strata and the libduckdb.so it links against (found via $$ORIGIN/../lib/strata).
install: build
	install -Dm755 target/release/strata $(PREFIX)/bin/strata
	install -Dm644 "$$(ls target/release/deps/libduckdb.so* | head -1)" $(PREFIX)/lib/strata/libduckdb.so
	@echo "installed $(PREFIX)/bin/strata"

# Rust API on :7420 + Vite dev server with hot reload on :5173.
dev: web/node_modules
	@echo "open http://localhost:5173 (API proxied to :7420)"
	( $(CARGO) run -- serve --no-open & cd web && npm run dev; kill %1 )

clean:
	$(CARGO) clean
	rm -rf web/dist fixtures/out
