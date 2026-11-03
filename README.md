# Conflate

Conflate is a small, modern desktop tool for resolving Git merge conflicts: a
3-pane (local / result / remote) merge view with click/arrow-driven hunk
resolution and solid auto-merge of non-conflicting changes, built with
[Tauri 2](https://tauri.app) (Rust backend, vanilla TypeScript frontend).

It was built to fill a specific gap: using [lazygit](https://github.com/jesseduffield/lazygit)
day to day but missing an editor-grade conflict UI — PhpStorm's 3-way layout
without pulling in all of PhpStorm.

> [!NOTE]
> **TODO (project owner):** add a screenshot or short screen-recording of the
> 3-pane merge view here. None is included in this README — it needs to be
> captured from a real running build, which this task could not do.

## What Conflate is not

- **Not a git client.** Conflate resolves the conflict in one file, one
  invocation at a time, and exits. It does not browse repositories, show
  history, stage files, or run git commands itself — [lazygit](https://github.com/jesseduffield/lazygit)
  (or your git client of choice) still owns everything else. Conflate is
  invoked *by* git (via `git mergetool`), not the other way around.
- **Not stateful.** There is no project memory or saved conflict history
  beyond a few UI preferences (theme override, window size).
- **Not a multi-file merge tool.** Each invocation handles exactly one
  `<base> <local> <remote> <merged>` quartet, matching git's own mergetool
  substitution convention.

## Platform support

**macOS only for v1.** This is the only platform Conflate is built for,
tested on, and ships releases for. The dependency set has nothing
macOS-specific in it, so it likely builds and runs on Linux/Windows too, but
that is untested and unsupported — please don't file issues for those
platforms against v1.

## Install

### Download a release

Grab the latest `.dmg` from the [Releases](../../releases) page, open it, and
drag `Conflate.app` into `/Applications`.

**Releases are unsigned and not notarized** (no Apple Developer account
code-signing in this project). macOS Gatekeeper will refuse to open an
unsigned, unnotarized app downloaded from the internet with a "Conflate is
damaged / can't be opened" message. Clear the quarantine flag after
installing:

```bash
xattr -d com.apple.quarantine /Applications/Conflate.app
```

Then open it normally.

Git needs to run Conflate from the command line, so after installing, either
point your mergetool config straight at the binary inside the app bundle (see
[Set up as your git mergetool](#set-up-as-your-git-mergetool)) or put it on
your `$PATH` as `conflate`:

```bash
# Any directory on your $PATH works; /usr/local/bin may need sudo (or
# `sudo mkdir -p /usr/local/bin` first on a fresh Apple Silicon Mac).
ln -s /Applications/Conflate.app/Contents/MacOS/conflate /usr/local/bin/conflate
```

### Build from source

See [Build from source](#build-from-source) below.

## Self-update

Conflate checks `dnwjn/conflate`'s GitHub releases for a newer version a few
seconds after launch, and silently does nothing if there isn't one — no
"you're up to date" popup on every run. If an update is found, a dismissible
banner appears; dismissing it means that version won't be mentioned again
(dismissal is per-version, not per-session). Click the version number in the
toolbar at any time to check manually. The update dialog downloads and
installs the new version in place; apply it with "Restart to Update".

This uses [`tauri-plugin-updater`](https://v2.tauri.app/plugin/updater/),
which verifies every downloaded update against an ed25519 signature before
installing it — a separate mechanism from (and no substitute for) the
Gatekeeper code-signing/notarization this project doesn't do (see
[Download a release](#download-a-release)).

**This requires the repo to be public.** The updater does a plain HTTPS GET
against `https://github.com/dnwjn/conflate/releases/latest/download/latest.json`
(the standard manifest URL `tauri-apps/tauri-action` publishes to on every
release) and then a second GET for the matched binary asset. Neither request
can carry auth, so a private repo's release assets simply aren't reachable
this way — no workaround is built in for that case. `dnwjn/conflate` is
currently private; the self-updater won't find anything until the repo is
made public.

### One-time maintainer setup (not automated)

Generate a signing keypair: `cargo tauri signer generate`. Put the printed
public key in `src-tauri/tauri.conf.json`'s `plugins.updater.pubkey`
(replacing the placeholder), and add the private key (and its password, if
set) as GitHub Actions secrets: `TAURI_SIGNING_PRIVATE_KEY`,
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Never commit the private key.

### Exercising the update UI in development

There's no real release endpoint to check against during development.
`npm run dev:stub` sets `VITE_STUB_UPDATE`, which makes `checkForUpdate`
(`src/update.ts`) skip the real plugin call and return a canned "newer
version available" update instead, so the banner/modal/download-progress
flow can be exercised end to end without a real Tauri runtime or a
published release. Set the same variable yourself (`VITE_STUB_UPDATE=1 npm
run dev`) to get the same effect in the plain browser preview.

## Set up as your git mergetool

Conflate is a CLI binary invokable with git's own mergetool substitution
convention:

```
conflate <BASE> <LOCAL> <REMOTE> <MERGED>
```

Add it to `~/.gitconfig`:

```ini
# ~/.gitconfig
[mergetool "conflate"]
    cmd = conflate "$BASE" "$LOCAL" "$REMOTE" "$MERGED"
    trustExitCode = true
[merge]
    tool = conflate
```

The CLI binary needs to be on your `$PATH` as `conflate`:

- **Installed from the `.dmg`:** the binary is
  `/Applications/Conflate.app/Contents/MacOS/conflate`. Symlink it onto your
  `$PATH` (see [Download a release](#download-a-release)), or skip `$PATH`
  entirely and use the full path in `cmd`:
  `cmd = /Applications/Conflate.app/Contents/MacOS/conflate "$BASE" "$LOCAL" "$REMOTE" "$MERGED"`.
- **Built from source:** the binary is `src-tauri/target/release/conflate`;
  symlink it onto your `$PATH`, e.g.
  `ln -s "$(pwd)/src-tauri/target/release/conflate" /usr/local/bin/conflate`.

Then, in any git repo with a conflict:

```bash
git mergetool
```

### lazygit

lazygit shells out to `git mergetool`, so once `mergetool.conflate` is
configured above (and set as `merge.tool`), lazygit just works — no
lazygit-specific configuration is needed. Trigger it from lazygit's Files
panel on a conflicted file (the default binding is `M` for "resolve merge
conflict with an external tool").

### Exit codes

- `0` — saved: the `merged` path was written via **Save & Finish**. Usually
  that means every conflict was resolved, but it also covers a forced save
  with unresolved conflicts still outstanding: Conflate asks for confirmation
  first ("Save anyway"), and if you confirm, it writes the result as it
  currently stands and still exits `0`, so git will treat the file as
  resolved.
- `1` — aborted, nothing written (`trustExitCode = true` tells git to leave
  the conflict in place). This is the exit code for the **Abort** button
  *and* for every other way of leaving without saving: closing the window,
  `⌘W`, or `⌘Q` / Conflate → Quit.
- `2` — fatal error before any window opens: bad arguments, a missing or
  unreadable `local`/`remote`, or an input that is not UTF-8 text (e.g. a
  binary file).

## Known limitations

- **Text files only.** Inputs must be UTF-8 text; binary files (images,
  archives, ...) are rejected with exit code `2` before a window opens. Use
  git's own tooling (`git checkout --ours/--theirs`) for those.
- **Line endings.** The merge itself works on LF line endings, so a file
  whose only difference between sides is CRLF vs LF never shows a false
  conflict. On save, Conflate writes the result back with the *dominant*
  line ending of the `local` (ours) file — CRLF if more than half of its
  line breaks are CRLF, otherwise LF (falling back to `remote` if `local`
  has no line breaks at all). A file that is consistently CRLF or
  consistently LF therefore keeps its line endings exactly. A file with
  **mixed** line endings comes out uniformly in its dominant ending: the
  minority lines will show up as changed in `git diff`.
- **A lone carriage return** (`\r` not followed by `\n`, e.g. in old
  classic-Mac files) is treated as ordinary line content, never as a line
  break, and is preserved in the vast majority of cases. The one known
  exception: a lone `\r` sitting directly before a CRLF line break (i.e.
  `\r\r\n`) can be dropped, since CRLF normalization isn't fully idempotent
  on that specific byte sequence. This is a rare, pre-existing edge case,
  not something to design around for ordinary files.

## Keyboard shortcuts

The full binding table (from `src/keymap.ts`, also shown in-app via the `?`
help overlay):

| Action | Shortcut |
|---|---|
| Next conflict | `⌥⌘.` |
| Previous conflict | `⌥⌘,` |
| Accept local | `⌥⌘←` |
| Accept remote | `⌥⌘→` |
| Accept both (local, then remote) | `⌥⌘↓` |
| Save & finish | `⌘S` |
| Abort merge | `⌘W` |
| Toggle word-diff highlighting | `⌥⌘H` |
| Toggle theme | `⌥⌘T` |
| Show keyboard shortcuts | `?` |

All chords match on physical key position (not the character produced), so
they're reliable regardless of what `⌥` remaps `.`/`,` to on your layout.

## Build from source

Requirements:

- [Rust](https://rustup.rs) (stable toolchain)
- [Node.js](https://nodejs.org) 22+
- macOS, with the Tauri 2 [macOS prerequisites](https://tauri.app/start/prerequisites/)

```bash
git clone https://github.com/<owner>/conflate.git
cd conflate
npm install
npm run tauri build
```

This produces `Conflate.app` and `Conflate_<version>_aarch64.dmg` in
`src-tauri/target/release/bundle/macos/` and `.../bundle/dmg/` respectively.

For local development (hot-reloading dev window), Conflate needs the same
four file arguments git would pass it — see
[CONTRIBUTING.md](CONTRIBUTING.md#local-dev-setup) for the exact command
(with a bare `npm run tauri dev`, the app exits `2` with a usage error).

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full dev workflow and test
suites.

## Design

The auto-merge algorithm is a standard base-anchored 3-way merge (same
family as `git merge-file`/`diff3`): hunks where only one side diverges from
base are auto-applied, hunks where both sides make the identical change are
auto-applied, and only genuinely overlapping, differing edits are left for
you to resolve by hand. See
`docs/design.md` for the full design
spec.

## License

Conflate is licensed under the [GNU General Public License v3.0](LICENSE).
