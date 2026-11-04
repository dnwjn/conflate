use crate::cli::Args;
use crate::diff::three_way::compute_three_way_merge;
use crate::diff::types::{ThreeWayMergeResult, WordDiffOp};
use crate::diff::word_diff::compute_word_diff;
use crate::exit::ExitCode;
use serde::Serialize;
use specta::Type;
use std::borrow::Cow;
use std::fs;
use std::path::Path;
use tauri::{AppHandle, State};

/// The three (or two, for add/add conflicts) input texts handed to the frontend,
/// plus a best-effort language hint derived from the file extension.
///
/// All texts are CRLF-normalized to LF (see `LineEnding`), matching what the
/// Rust 3-way merge diffs, so every hunk line index lines up with the panes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MergeInputPayload {
    /// `None` when the base file does not exist on disk (add/add conflict).
    pub base: Option<String>,
    pub local: String,
    pub remote: String,
    pub language_hint: Option<String>,
    /// Basename of the `merged` path (the file being resolved), for the
    /// window title — so a multi-file `git mergetool` run shows which file
    /// is currently open.
    pub file_name: String,
    /// Absolute, best-effort path of the `merged` file (the one being
    /// resolved), for display when the user wants to confirm exactly which
    /// file on disk this is. Resolved against the process cwd when `merged`
    /// was passed as a relative path (git's own convention); shown as-is if
    /// that cwd lookup fails.
    pub full_path: String,
    /// Best-effort branch labels for the LOCAL/REMOTE panes (see
    /// `git_labels::detect_branch_labels`). `None` when they can't be
    /// determined — the frontend falls back to its existing "HEAD"/no-label
    /// defaults in that case.
    pub local_branch: Option<String>,
    pub remote_branch: Option<String>,
}

/// The dominant line ending of the file being merged. The 3-way merge (and
/// therefore the whole UI) works in LF only; `save_result` converts back so a
/// CRLF file is not silently rewritten to LF.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineEnding {
    Lf,
    Crlf,
}

impl LineEnding {
    /// CRLF if strictly more than half of `text`'s line breaks are CRLF,
    /// otherwise LF (including for text with no line breaks at all).
    pub fn detect(text: &str) -> Self {
        let breaks = text.matches('\n').count();
        let crlf = text.matches("\r\n").count();
        if crlf * 2 > breaks {
            LineEnding::Crlf
        } else {
            LineEnding::Lf
        }
    }

    /// Converts LF-normalized `text` to this line ending. For a file whose
    /// line breaks were all CRLF, `Crlf.apply(&normalize_crlf(original))` is
    /// byte-for-byte `original` (normalization maps each `\r\n` to exactly
    /// one `\n`, and this maps each `\n` back). In a mixed file, the
    /// minority LF lines come out as CRLF.
    pub fn apply(self, text: &str) -> Cow<'_, str> {
        match self {
            LineEnding::Lf => Cow::Borrowed(text),
            LineEnding::Crlf => Cow::Owned(text.replace('\n', "\r\n")),
        }
    }
}

/// CRLF -> LF, identical to the normalization `compute_three_way_merge`
/// applies internally (a lone `\r` is left untouched).
fn normalize_crlf(text: String) -> String {
    if text.contains("\r\n") {
        text.replace("\r\n", "\n")
    } else {
        text
    }
}

/// Everything read from disk at startup, validated before any window opens
/// (see `main.rs`), and kept in Tauri managed state for the session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadedInput {
    pub payload: MergeInputPayload,
    /// The line ending `save_result` restores on write.
    pub line_ending: LineEnding,
}

/// Converts raw file bytes to text, rejecting content that is not valid UTF-8
/// (a cheap, reliable proxy for "this is a binary file").
pub fn read_text_file_checked(bytes: &[u8]) -> Result<String, String> {
    String::from_utf8(bytes.to_vec())
        .map_err(|_| "file is not valid UTF-8 text (it may be a binary file)".to_string())
}

fn read_file_checked(path: &Path, role: &str) -> Result<String, String> {
    let bytes =
        fs::read(path).map_err(|e| format!("cannot read {role} file {}: {e}", path.display()))?;
    read_text_file_checked(&bytes).map_err(|e| format!("{role} file {}: {e}", path.display()))
}

/// Best-effort source-language hint, taken from the local file's extension
/// (falling back to the remote file's) for syntax highlighting purposes only.
fn language_hint_for(local: &Path, remote: &Path) -> Option<String> {
    local
        .extension()
        .or_else(|| remote.extension())
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_lowercase())
}

/// Basename of `merged` (falling back to the whole path if it has none).
fn file_name_for(merged: &Path) -> String {
    merged
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| merged.display().to_string())
}

/// Best-effort absolute path of `merged`: used as-is if already absolute,
/// otherwise joined onto the process's current directory (mirrors how
/// `git mergetool` invokes conflate — `merged` is relative to the repo root,
/// which is the cwd). Never touches the filesystem (no `canonicalize`), so it
/// works even though `merged` may not exist yet.
fn full_path_for(merged: &Path) -> String {
    if merged.is_absolute() {
        return merged.display().to_string();
    }
    std::env::current_dir()
        .map(|cwd| cwd.join(merged).display().to_string())
        .unwrap_or_else(|_| merged.display().to_string())
}

/// Reads and validates local/remote (required) and base (optional) into a
/// `LoadedInput`. A missing base path means an add/add conflict, not an
/// error: `base` is `None`. Any read failure or non-UTF-8 (binary) content is
/// an `Err` — `main.rs` calls this BEFORE the Tauri app is built, so such a
/// file exits with code 2 without ever opening a window.
pub fn load_merge_input(
    base: &Path,
    local: &Path,
    remote: &Path,
    merged: &Path,
) -> Result<LoadedInput, String> {
    let local_content = read_file_checked(local, "local")?;
    let remote_content = read_file_checked(remote, "remote")?;
    let base_content = if base.exists() {
        Some(read_file_checked(base, "base")?)
    } else {
        None
    };
    // The file being merged is local's (ours) version; fall back to remote's
    // when local has no line breaks to judge by (e.g. an empty local).
    let line_ending = if local_content.contains('\n') {
        LineEnding::detect(&local_content)
    } else {
        LineEnding::detect(&remote_content)
    };
    let language_hint = language_hint_for(local, remote);
    // `base`/`local`/`remote` are git's own scratch temp files when conflate
    // is actually run as a mergetool (git's machinery names them literally
    // `..._BASE_<pid>`/`_LOCAL_<pid>`/`_REMOTE_<pid>`, already fully read
    // into `LoadedInput` above — nothing in this process touches them
    // again). Git itself only deletes them when the tool exits 0; our own
    // Abort deliberately exits 1 (see `ExitCode`) so the conflict stays
    // resumable, which means git leaves them orphaned on disk forever.
    // Deleting them here, unconditionally and before any exit-code decision,
    // stops that litter regardless of how the session ends.
    //
    // But these same 4 positional arguments are also conflate's whole public
    // CLI contract (see `cli.rs`) — nothing stops someone invoking it
    // directly on real, non-disposable files (this very repo's own
    // `npm run dev:stub` points it straight at the checked-in
    // `dev-fixtures/sample/*.ts`). So only delete a path that actually
    // matches git's own naming convention for its temp files
    // (`is_git_mergetool_temp_file`); anything else is left untouched.
    // `merged` is never a candidate either way: it's the path git expects us
    // to (maybe) write the resolved result to.
    if is_git_mergetool_temp_file(local, "LOCAL") {
        delete_best_effort(local);
    }
    if is_git_mergetool_temp_file(remote, "REMOTE") {
        delete_best_effort(remote);
    }
    if is_git_mergetool_temp_file(base, "BASE") {
        delete_best_effort(base);
    }
    Ok(LoadedInput {
        payload: MergeInputPayload {
            base: base_content.map(normalize_crlf),
            local: normalize_crlf(local_content),
            remote: normalize_crlf(remote_content),
            language_hint,
            file_name: file_name_for(merged),
            full_path: full_path_for(merged),
            // Filled in by `main.rs` right after this returns: it needs the
            // process's actual cwd, which this function has no reason to
            // depend on otherwise (keeps this purely file-reading, and keeps
            // its existing tests free of git subprocess calls).
            local_branch: None,
            remote_branch: None,
        },
        line_ending,
    })
}

/// Best-effort delete: a failure here (permissions, already gone, etc.) must
/// never block the merge UI from opening, so errors are silently ignored.
fn delete_best_effort(path: &Path) {
    let _ = fs::remove_file(path);
}

/// Whether `path`'s file stem ends in git's own mergetool temp-file naming
/// convention for `role` (`"BASE"`/`"LOCAL"`/`"REMOTE"`) — `<name>_<role>_<pid>`,
/// e.g. `team-roster_LOCAL_18572.tsx` — `<pid>` being one or more ASCII
/// digits (the git process's pid). A path that doesn't match this exactly
/// (a hand-picked file, a dev fixture, anything without the role+pid
/// suffix) is never a deletion candidate, regardless of which CLI
/// positional argument it was passed as.
fn is_git_mergetool_temp_file(path: &Path, role: &str) -> bool {
    let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
        return false;
    };
    let marker = format!("_{role}_");
    let Some(idx) = stem.rfind(&marker) else {
        return false;
    };
    let suffix = &stem[idx + marker.len()..];
    !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit())
}

/// Writes `content` (LF-only, as produced by the merge UI) to `merged_path`
/// converted to `line_ending`, refusing a silent partial save: if conflicts
/// remain unresolved and the caller hasn't explicitly forced it, returns an
/// error instead of writing anything.
pub fn save_result_inner(
    content: &str,
    unresolved_count: u32,
    force: bool,
    merged_path: &Path,
    line_ending: LineEnding,
) -> Result<(), String> {
    if unresolved_count > 0 && !force {
        return Err(format!("{unresolved_count} unresolved conflicts remain"));
    }
    fs::write(merged_path, line_ending.apply(content).as_bytes())
        .map_err(|e| format!("cannot write merged file {}: {e}", merged_path.display()))
}

/// Tauri command: returns the merge input `main.rs` already read and
/// validated (before the window opened) and stashed in managed state. Still
/// `Result` so the frontend's existing error-state handling stays in place.
#[tauri::command]
#[specta::specta]
pub fn get_merge_input(loaded: State<LoadedInput>) -> Result<MergeInputPayload, String> {
    Ok(loaded.payload.clone())
}

/// Tauri command: writes the resolved content to the `merged` path from the
/// command line (restoring the input's line ending), then exits the process
/// with `ExitCode::Resolved` so git's mergetool machinery treats the conflict
/// as resolved. Refuses to write (see `save_result_inner`) unless every
/// conflict is resolved or `force` is set, so the frontend's "save anyway?"
/// confirmation is the only way past that gate.
#[tauri::command]
#[specta::specta]
pub fn save_result(
    app: AppHandle,
    args: State<Args>,
    loaded: State<LoadedInput>,
    content: String,
    unresolved_count: u32,
    force: bool,
) -> Result<(), String> {
    save_result_inner(
        &content,
        unresolved_count,
        force,
        &args.merged,
        loaded.line_ending,
    )?;
    app.exit(ExitCode::Resolved as i32);
    Ok(())
}

/// Tauri command: aborts the merge without writing anything, exiting with
/// `ExitCode::Aborted` so git treats the conflict as still unresolved.
#[tauri::command]
#[specta::specta]
pub fn abort_merge(app: AppHandle) {
    app.exit(ExitCode::Aborted as i32);
}

/// Tauri command: wraps `three_way::compute_three_way_merge` (Task 5).
///
/// `base: None` from the frontend means "no common ancestor" (add/add
/// conflict), forwarded unchanged. The pure function's `Err(MergeError)` is
/// mapped to a plain `String` so a genuine internal invariant violation
/// rejects the frontend's promise distinctly from a normal successful merge
/// result with `conflict_count > 0` (never silently swallowed, never
/// panics).
#[tauri::command]
#[specta::specta]
pub fn compute_three_way_merge_command(
    base: Option<String>,
    local: String,
    remote: String,
) -> Result<ThreeWayMergeResult, String> {
    compute_three_way_merge(base.as_deref(), &local, &remote).map_err(|e| e.to_string())
}

/// Tauri command: wraps `word_diff::compute_word_diff` (Task 6). Infallible,
/// so it is a plain passthrough.
///
/// The second parameter is named `new_text`, not `new`: `new` is a reserved
/// word in TypeScript/JavaScript and cannot be a parameter identifier in the
/// `tauri-specta`-generated binding function, so using it here would make
/// `src/bindings.ts` a syntax error.
#[tauri::command]
#[specta::specta]
pub fn compute_word_diff_command(old: String, new_text: String) -> Vec<WordDiffOp> {
    compute_word_diff(&old, &new_text)
}

/// Tauri command: whether this session was launched as a `git mergetool`
/// invocation (`get_merge_input`/`save_result`/`abort_merge` are usable) or
/// with no args at all (the frontend shows the empty-state/repo-browser
/// screen instead). See `crate::LaunchModeMarker`.
#[tauri::command]
#[specta::specta]
pub fn get_launch_mode(marker: State<crate::LaunchModeMarker>) -> bool {
    marker.is_merge
}

/// Tauri command: opens a native folder picker for the empty-state repo
/// browser. `None` if the user cancels.
#[tauri::command]
#[specta::specta]
pub async fn pick_repo_folder(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path);
    });
    rx.recv()
        .ok()
        .flatten()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.display().to_string())
}

/// Tauri command: scans a folder the user picked for a git repo with a
/// merge in progress, listing any unmerged (conflicted) files.
#[tauri::command]
#[specta::specta]
pub fn scan_repo_for_conflicts(repo_path: String) -> crate::repo_scan::RepoScanResult {
    crate::repo_scan::scan_repo(Path::new(&repo_path))
}

/// Tauri command: loads one conflicted file's base/local/remote content
/// straight from `repo_path`'s git index, for the empty-state repo browser.
#[tauri::command]
#[specta::specta]
pub fn load_conflict_from_repo(
    repo_path: String,
    file_path: String,
) -> Result<MergeInputPayload, String> {
    crate::repo_scan::load_conflict_from_repo(Path::new(&repo_path), &file_path)
        .map(|loaded| loaded.payload)
}

/// Tauri command: writes a conflict resolved via the empty-state repo
/// browser to its real working-tree file (not a mergetool temp file,
/// since there is no `$MERGED` path in this flow) and stages it with
/// `git add`, mirroring what resolving via `git mergetool` leaves behind.
#[tauri::command]
#[specta::specta]
pub fn save_repo_conflict_resolution(
    repo_path: String,
    file_path: String,
    content: String,
) -> Result<(), String> {
    let repo_root = Path::new(&repo_path);
    let target = repo_root.join(&file_path);
    fs::write(&target, content)
        .map_err(|e| format!("cannot write {}: {e}", target.display()))?;
    let output = std::process::Command::new("git")
        .args(["add", "--", &file_path])
        .current_dir(repo_root)
        .output()
        .map_err(|e| format!("cannot run git add: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git add {file_path} failed: {stderr}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::diff::three_way;

    #[test]
    fn compute_three_way_merge_command_matches_pure_function() {
        let direct = three_way::compute_three_way_merge(Some("a\n"), "a\n", "a\n").unwrap();
        let via_command =
            compute_three_way_merge_command(Some("a\n".into()), "a\n".into(), "a\n".into())
                .unwrap();
        assert_eq!(direct.conflict_count, via_command.conflict_count);
    }

    #[test]
    fn compute_word_diff_command_matches_pure_function() {
        let direct = crate::diff::word_diff::compute_word_diff("a b", "a c");
        let via_command = compute_word_diff_command("a b".into(), "a c".into());

        assert_eq!(direct, via_command);
    }

    #[test]
    fn rejects_binary_file_content() {
        let bytes = vec![0u8, 159, 146, 150]; // invalid UTF-8
        assert!(read_text_file_checked(&bytes).is_err());
    }

    #[test]
    fn missing_base_path_yields_none_not_error() {
        let dir = tempfile::tempdir().unwrap();
        let local_path = dir.path().join("local.txt");
        let remote_path = dir.path().join("remote.txt");
        std::fs::write(&local_path, "local content").unwrap();
        std::fs::write(&remote_path, "remote content").unwrap();
        let loaded = load_merge_input(
            &dir.path().join("absent_base.txt"),
            &local_path,
            &remote_path,
            &dir.path().join("merged.txt"),
        )
        .unwrap();
        assert!(loaded.payload.base.is_none());
    }

    #[test]
    fn save_result_requires_force_when_unresolved_remain() {
        let dir = tempfile::tempdir().unwrap();
        let merged_path = dir.path().join("merged.txt");
        let err = save_result_inner("content", 2, false, &merged_path, LineEnding::Lf).unwrap_err();
        assert!(err.contains("unresolved"), "error was: {err}");
    }

    #[test]
    fn save_result_succeeds_with_force_despite_unresolved() {
        let dir = tempfile::tempdir().unwrap();
        let merged_path = dir.path().join("merged.txt");
        assert!(save_result_inner("content", 2, true, &merged_path, LineEnding::Lf).is_ok());
    }

    #[test]
    fn save_result_succeeds_when_zero_unresolved() {
        let dir = tempfile::tempdir().unwrap();
        let merged_path = dir.path().join("merged.txt");
        assert!(save_result_inner("content", 0, false, &merged_path, LineEnding::Lf).is_ok());
    }

    fn write_inputs(dir: &Path, base: Option<&[u8]>, local: &[u8], remote: &[u8]) {
        if let Some(base) = base {
            std::fs::write(dir.join("base.txt"), base).unwrap();
        }
        std::fs::write(dir.join("local.txt"), local).unwrap();
        std::fs::write(dir.join("remote.txt"), remote).unwrap();
    }

    fn load(dir: &Path) -> Result<LoadedInput, String> {
        load_merge_input(
            &dir.join("base.txt"),
            &dir.join("local.txt"),
            &dir.join("remote.txt"),
            &dir.join("sub").join("pricing.rs"),
        )
    }

    #[test]
    fn load_rejects_binary_local_remote_or_base() {
        let binary: &[u8] = &[0, 159, 146, 150];
        for (base, local, remote, role) in [
            (None, binary, b"r\n" as &[u8], "local"),
            (None, b"l\n" as &[u8], binary, "remote"),
            (Some(binary), b"l\n" as &[u8], b"r\n" as &[u8], "base"),
        ] {
            let dir = tempfile::tempdir().unwrap();
            write_inputs(dir.path(), base, local, remote);
            let err = load(dir.path()).unwrap_err();
            assert!(err.starts_with(role), "{role}: {err}");
            assert!(err.contains("not valid UTF-8"), "{role}: {err}");
        }
    }

    #[test]
    fn load_deletes_git_mergetool_style_temp_files_but_never_merged() {
        // Named exactly like git's own mergetool temp files
        // (`<name>_<ROLE>_<pid>.<ext>`), the only thing that makes a path a
        // deletion candidate (see `is_git_mergetool_temp_file`).
        let dir = tempfile::tempdir().unwrap();
        let base_path = dir.path().join("pricing_BASE_18572.rs");
        let local_path = dir.path().join("pricing_LOCAL_18572.rs");
        let remote_path = dir.path().join("pricing_REMOTE_18572.rs");
        std::fs::write(&base_path, "b\n").unwrap();
        std::fs::write(&local_path, "l\n").unwrap();
        std::fs::write(&remote_path, "r\n").unwrap();
        let merged_path = dir.path().join("sub").join("pricing.rs");
        std::fs::create_dir_all(merged_path.parent().unwrap()).unwrap();
        std::fs::write(&merged_path, "conflict markers\n").unwrap();

        load_merge_input(&base_path, &local_path, &remote_path, &merged_path).unwrap();

        assert!(!base_path.exists());
        assert!(!local_path.exists());
        assert!(!remote_path.exists());
        assert!(merged_path.exists(), "merged must never be deleted");
    }

    #[test]
    fn load_leaves_plain_named_inputs_on_disk_untouched() {
        // Conflate's 4 positional CLI args are its whole public contract
        // (see `cli.rs`), invokable directly on real files — not only as
        // git's own disposable mergetool temp files. This repo's own
        // `npm run dev:stub` points conflate straight at the checked-in
        // `dev-fixtures/sample/*.ts`; a plain name like `base.txt` must
        // never be treated as disposable just because it was passed as the
        // `base` argument.
        let dir = tempfile::tempdir().unwrap();
        write_inputs(dir.path(), Some(b"b\n"), b"l\n", b"r\n");
        load(dir.path()).unwrap();
        assert!(dir.path().join("base.txt").exists());
        assert!(dir.path().join("local.txt").exists());
        assert!(dir.path().join("remote.txt").exists());
    }

    #[test]
    fn is_git_mergetool_temp_file_matches_only_the_exact_role_and_pid_suffix() {
        let yes = [
            ("pricing_LOCAL_18572.rs", "LOCAL"),
            ("a_file_with_underscores_BASE_1.ts", "BASE"),
            ("x_REMOTE_999999.tsx", "REMOTE"),
        ];
        for (name, role) in yes {
            assert!(
                is_git_mergetool_temp_file(Path::new(name), role),
                "{name} should match role {role}"
            );
        }
        let no = [
            ("base.txt", "BASE"),
            ("pricing_LOCAL_.rs", "LOCAL"),    // no pid digits
            ("pricing_LOCAL_abc.rs", "LOCAL"), // non-numeric suffix
            ("pricing_REMOTE_12.rs", "LOCAL"), // wrong role
        ];
        for (name, role) in no {
            assert!(
                !is_git_mergetool_temp_file(Path::new(name), role),
                "{name} should NOT match role {role}"
            );
        }
    }

    #[test]
    fn load_with_no_base_file_does_not_error_trying_to_delete_it() {
        let dir = tempfile::tempdir().unwrap();
        write_inputs(dir.path(), None, b"l\n", b"r\n");
        assert!(load(dir.path()).is_ok());
    }

    #[test]
    fn payload_carries_merged_basename_for_the_window_title() {
        let dir = tempfile::tempdir().unwrap();
        write_inputs(dir.path(), None, b"l\n", b"r\n");
        assert_eq!(load(dir.path()).unwrap().payload.file_name, "pricing.rs");
    }

    #[test]
    fn payload_carries_the_merged_files_full_path() {
        let dir = tempfile::tempdir().unwrap();
        write_inputs(dir.path(), None, b"l\n", b"r\n");
        let expected = dir.path().join("sub").join("pricing.rs");
        assert_eq!(
            load(dir.path()).unwrap().payload.full_path,
            expected.display().to_string()
        );
    }

    #[test]
    fn line_ending_detection_picks_the_dominant_ending() {
        assert_eq!(LineEnding::detect("a\r\nb\r\n"), LineEnding::Crlf);
        assert_eq!(LineEnding::detect("a\nb\n"), LineEnding::Lf);
        assert_eq!(LineEnding::detect("a\r\nb\r\nc\n"), LineEnding::Crlf);
        assert_eq!(LineEnding::detect("a\r\nb\nc\n"), LineEnding::Lf);
        assert_eq!(LineEnding::detect("a\r\nb\n"), LineEnding::Lf); // tie -> LF
        assert_eq!(LineEnding::detect("no breaks"), LineEnding::Lf);
        assert_eq!(LineEnding::detect("a\rb\n"), LineEnding::Lf); // lone \r is content
    }

    #[test]
    fn crlf_input_is_normalized_for_the_ui_and_restored_byte_for_byte_on_save() {
        let dir = tempfile::tempdir().unwrap();
        // Includes a lone `\r` and a `\r` right before a CRLF break, the two
        // spots where a naive conversion would corrupt content.
        let local = "one\r\nt\rwo\r\nthree\r\r\n";
        write_inputs(
            dir.path(),
            Some(b"one\r\n"),
            local.as_bytes(),
            b"one\r\nx\r\n",
        );
        let loaded = load(dir.path()).unwrap();
        assert_eq!(loaded.line_ending, LineEnding::Crlf);
        assert_eq!(loaded.payload.local, "one\nt\rwo\nthree\r\n");
        assert_eq!(loaded.payload.remote, "one\nx\n");
        assert_eq!(loaded.payload.base.as_deref(), Some("one\n"));

        // Saving local's (LF) content unchanged reproduces the original file.
        let merged = dir.path().join("merged.txt");
        save_result_inner(&loaded.payload.local, 0, false, &merged, loaded.line_ending).unwrap();
        assert_eq!(std::fs::read_to_string(&merged).unwrap(), local);
        // And a new line typed in the UI (LF) comes out CRLF.
        save_result_inner("one\nnew\n", 0, false, &merged, loaded.line_ending).unwrap();
        assert_eq!(std::fs::read_to_string(&merged).unwrap(), "one\r\nnew\r\n");
    }

    #[test]
    fn lf_input_is_saved_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        write_inputs(dir.path(), None, b"a\rb\nc\n", b"a\n");
        let loaded = load(dir.path()).unwrap();
        assert_eq!(loaded.line_ending, LineEnding::Lf);
        let merged = dir.path().join("merged.txt");
        save_result_inner("a\rb\nc\n", 0, false, &merged, loaded.line_ending).unwrap();
        assert_eq!(std::fs::read_to_string(&merged).unwrap(), "a\rb\nc\n");
    }

    #[test]
    fn empty_local_takes_its_line_ending_from_remote() {
        let dir = tempfile::tempdir().unwrap();
        write_inputs(dir.path(), None, b"", b"a\r\nb\r\n");
        assert_eq!(load(dir.path()).unwrap().line_ending, LineEnding::Crlf);
    }
}
