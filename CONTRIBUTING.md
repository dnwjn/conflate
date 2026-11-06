# Contributing to Conflate

## Local dev setup

Requirements: [Rust](https://rustup.rs) (stable), [Node.js](https://nodejs.org) 22+,
and macOS with the Tauri 2 [macOS prerequisites](https://tauri.app/start/prerequisites/).

```bash
pnpm install
```

Conflate always needs git's four mergetool arguments
(`<base> <local> <remote> <merged>`); with a bare `pnpm run tauri dev` the app
itself exits `2` with a usage error before any window opens. A small sample conflict trio
lives in `dev-fixtures/sample/` (it covers every hunk kind: conflicts,
including a delete-vs-modify one, local-only, remote-only, and same-change
edits). Run the hot-reloading dev window against it with:

```bash
pnpm run tauri dev -- -- \
  "$PWD/dev-fixtures/sample/base.ts" \
  "$PWD/dev-fixtures/sample/local.ts" \
  "$PWD/dev-fixtures/sample/remote.ts" \
  /tmp/conflate-merged.ts
```

Notes:

- **Two `--`, not one.** The Tauri CLI reads the first as "runner (cargo)
  arguments start here", and only arguments after the *second* reach
  Conflate itself (`tauri dev -- [runnerArgs] -- [appArgs]`).
- **Use absolute paths** (hence `$PWD`): the app is not guaranteed to run
  with the repository root as its working directory.
- **Point `merged` somewhere disposable** — Save & Finish overwrites it. Never
  point it at one of the fixture files.
- To try your own conflict, swap in any three files (`base` may be a path
  that doesn't exist, which simulates an add/add conflict).

See `TESTING.md` for the manual smoke-test checklist to run through after
any change to the merge view (`src/merge/threeWayView.ts`).

## Project layout

- `src-tauri/src/` — Rust backend: CLI parsing (`cli.rs`), Tauri commands
  (`commands.rs`), and the 3-way diff/auto-merge core (`diff/`).
- `src/` — TypeScript frontend: the 3-pane CM6 merge view (`merge/`), typed
  IPC bindings (`ipc.ts`, generated `bindings.ts`), keymap (`keymap.ts`),
  theming (`theme.ts`), and persisted preferences (`prefs.ts`).
- `src-tauri/tests/` — Rust integration tests: the 3-way merge
  (`three_way_merge.rs`) and the CLI's exit-code contract (`cli_exit.rs`).
  Merge test cases are inline strings in the test files; there is no
  separate test-fixture directory.
- `dev-fixtures/sample/` — the base/local/remote trio for running the dev
  build by hand (see above). A Rust test
  (`dev_fixture_sample_covers_every_hunk_kind`) keeps it covering every hunk
  kind.

## Running the test suites

Run all of these before opening a PR — they're also what CI runs:

```bash
# Rust: unit + integration tests
(cd src-tauri && cargo test)

# Rust: lint, warnings are errors
(cd src-tauri && cargo clippy -- -D warnings)

# Frontend: Vitest unit tests
pnpm test

# Frontend: type checking
pnpm run typecheck

# Frontend: lint + format check (Biome)
pnpm run lint
```

If you've touched `src-tauri/src/commands.rs` or any `#[specta]`-annotated
type, re-check that the generated TypeScript bindings (consumed via
`src/ipc.ts`) are still in sync — the Rust test suite includes a binding
export check for this.

## Commit/PR conventions

Keep commits scoped and use [Conventional Commits](https://www.conventionalcommits.org/)
style subjects (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`,
etc.). Open a PR against `main`; CI (`.github/workflows/ci.yml`) must be
green before merge.
