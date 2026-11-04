use crate::commands::{self, LineEnding, LoadedInput, MergeInputPayload};
use crate::git_labels;
use serde::Serialize;
use specta::Type;
use std::path::{Path, PathBuf};
use std::process::Command;

/// One file git reports as unmerged (conflicted) in a repo mid-merge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictedFile {
    /// Path relative to the repo root, as git reports it.
    pub path: String,
}

/// Result of scanning a folder the user picked in the empty-state repo
/// browser.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RepoScanResult {
    /// Not inside a git repo at all (or `git` isn't on `$PATH`).
    NotARepo,
    /// A git repo, but no merge is in progress — or one is, but every
    /// conflicted path has already been resolved (staged) without being
    /// committed yet.
    NoMergeInProgress,
    /// A merge is in progress with 1+ unmerged files.
    #[serde(rename_all = "camelCase")]
    Conflicted {
        repo_root: String,
        files: Vec<ConflictedFile>,
    },
}

/// Runs `git` with `args` inside `dir`, returning its raw stdout on a clean
/// exit. `None` on any failure: nonzero exit, `git` missing, or non-UTF-8
/// output.
fn run_git(dir: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).current_dir(dir).output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

/// Scans `dir` for a git repo with a merge in progress and unmerged
/// (conflicted) files.
pub fn scan_repo(dir: &Path) -> RepoScanResult {
    let Some(root) = run_git(dir, &["rev-parse", "--show-toplevel"]) else {
        return RepoScanResult::NotARepo;
    };
    let root = root.trim().to_string();
    if run_git(Path::new(&root), &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_none() {
        return RepoScanResult::NoMergeInProgress;
    }
    let Some(listing) = run_git(
        Path::new(&root),
        &["diff", "--name-only", "--diff-filter=U"],
    ) else {
        return RepoScanResult::NoMergeInProgress;
    };
    let files: Vec<ConflictedFile> = listing
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|path| ConflictedFile {
            path: path.to_string(),
        })
        .collect();
    if files.is_empty() {
        RepoScanResult::NoMergeInProgress
    } else {
        RepoScanResult::Conflicted {
            repo_root: root,
            files,
        }
    }
}

/// Reads one git index stage (`:1` base, `:2` local/ours, `:3` remote/theirs)
/// for `repo_relative_path` via `git show`. Stage 1 missing (add/add
/// conflict) is reported via `required = false` so the caller can map it to
/// `None` rather than an error; stages 2/3 are always `required = true`.
fn read_stage(
    repo_root: &Path,
    stage: u8,
    repo_relative_path: &str,
    required: bool,
) -> Result<Option<String>, String> {
    let spec = format!(":{stage}:{repo_relative_path}");
    let output = Command::new("git")
        .args(["show", &spec])
        .current_dir(repo_root)
        .output()
        .map_err(|e| format!("cannot run git show {spec}: {e}"))?;
    if !output.status.success() {
        if required {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("cannot read stage {stage} of {repo_relative_path}: {stderr}"));
        }
        return Ok(None);
    }
    let text = commands::read_text_file_checked(&output.stdout)
        .map_err(|e| format!("{repo_relative_path}: {e}"))?;
    Ok(Some(text))
}

/// Materializes a conflicted file's base/local/remote content straight from
/// git's index (stages `:1`/`:2`/`:3`), without needing git's mergetool
/// temp-file machinery — used by the empty-state repo browser, which finds
/// conflicts directly in a repo rather than being invoked by
/// `git mergetool`.
pub fn load_conflict_from_repo(
    repo_root: &Path,
    repo_relative_path: &str,
) -> Result<LoadedInput, String> {
    let base_content = read_stage(repo_root, 1, repo_relative_path, false)?;
    let local_content = read_stage(repo_root, 2, repo_relative_path, true)?
        .expect("required stage read returns Some on success");
    let remote_content = read_stage(repo_root, 3, repo_relative_path, true)?
        .expect("required stage read returns Some on success");

    let line_ending = if local_content.contains('\n') {
        LineEnding::detect(&local_content)
    } else {
        LineEnding::detect(&remote_content)
    };
    let path = Path::new(repo_relative_path);
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| repo_relative_path.to_string());
    let full_path: PathBuf = repo_root.join(path);
    let language_hint = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_lowercase());
    let (local_branch, remote_branch) = git_labels::detect_branch_labels(repo_root);

    Ok(LoadedInput {
        payload: MergeInputPayload {
            base: base_content,
            local: local_content,
            remote: remote_content,
            language_hint,
            file_name,
            full_path: full_path.display().to_string(),
            local_branch,
            remote_branch,
        },
        line_ending,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn git(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(dir)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed");
    }

    fn init_repo(dir: &Path) {
        git(dir, &["init", "-q"]);
        git(dir, &["checkout", "-q", "-b", "main"]);
        git(dir, &["config", "user.email", "test@example.com"]);
        git(dir, &["config", "user.name", "Test"]);
        // Disables this throwaway repo's commit signing regardless of the
        // developer machine's global git config (e.g. a 1Password-backed
        // signing key, which has no agent to talk to in a sandboxed test run).
        git(dir, &["config", "commit.gpgsign", "false"]);
    }

    /// Sets up a repo with a genuine conflicting merge in progress: `main`
    /// and `feature` both edit `file.txt` after a common ancestor commit.
    fn make_conflicted_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        fs::write(dir.path().join("file.txt"), "base\n").unwrap();
        git(dir.path(), &["add", "."]);
        git(dir.path(), &["commit", "-q", "-m", "base"]);

        git(dir.path(), &["checkout", "-q", "-b", "feature"]);
        fs::write(dir.path().join("file.txt"), "local change\n").unwrap();
        git(dir.path(), &["commit", "-q", "-am", "local"]);

        git(dir.path(), &["checkout", "-q", "main"]);
        fs::write(dir.path().join("file.txt"), "remote change\n").unwrap();
        git(dir.path(), &["commit", "-q", "-am", "remote"]);

        // Non-fast-forward merge, expected to conflict; `git merge`'s
        // nonzero exit here is the point, not a test failure.
        let _ = Command::new("git")
            .args(["merge", "-q", "--no-edit", "feature"])
            .current_dir(dir.path())
            .status();
        dir
    }

    #[test]
    fn a_non_git_directory_is_not_a_repo() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(scan_repo(dir.path()), RepoScanResult::NotARepo);
    }

    #[test]
    fn a_clean_repo_has_no_merge_in_progress() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        fs::write(dir.path().join("file.txt"), "hello\n").unwrap();
        git(dir.path(), &["add", "."]);
        git(dir.path(), &["commit", "-q", "-m", "initial"]);
        assert_eq!(
            scan_repo(dir.path()),
            RepoScanResult::NoMergeInProgress
        );
    }

    #[test]
    fn a_conflicted_merge_lists_the_unmerged_file() {
        let dir = make_conflicted_repo();
        match scan_repo(dir.path()) {
            RepoScanResult::Conflicted { files, .. } => {
                assert_eq!(files, vec![ConflictedFile { path: "file.txt".into() }]);
            }
            other => panic!("expected Conflicted, got {other:?}"),
        }
    }

    #[test]
    fn loads_base_local_remote_content_for_a_conflicted_file() {
        let dir = make_conflicted_repo();
        let loaded = load_conflict_from_repo(dir.path(), "file.txt").unwrap();
        assert_eq!(loaded.payload.base.as_deref(), Some("base\n"));
        // Stage 2 (local/"ours") is whatever `main` (the branch merged
        // *into*) held; stage 3 (remote/"theirs") is `feature`'s content —
        // matching git mergetool's own $LOCAL/$REMOTE convention.
        assert_eq!(loaded.payload.local, "remote change\n");
        assert_eq!(loaded.payload.remote, "local change\n");
        assert_eq!(loaded.payload.file_name, "file.txt");
    }

    #[test]
    fn add_add_conflict_yields_none_base_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        fs::write(dir.path().join("common.txt"), "x\n").unwrap();
        git(dir.path(), &["add", "."]);
        git(dir.path(), &["commit", "-q", "-m", "base"]);

        git(dir.path(), &["checkout", "-q", "-b", "feature"]);
        fs::write(dir.path().join("new.txt"), "from feature\n").unwrap();
        git(dir.path(), &["add", "."]);
        git(dir.path(), &["commit", "-q", "-m", "add on feature"]);

        git(dir.path(), &["checkout", "-q", "main"]);
        fs::write(dir.path().join("new.txt"), "from main\n").unwrap();
        git(dir.path(), &["add", "."]);
        git(dir.path(), &["commit", "-q", "-m", "add on main"]);

        let _ = Command::new("git")
            .args(["merge", "-q", "--no-edit", "feature"])
            .current_dir(dir.path())
            .status();

        let loaded = load_conflict_from_repo(dir.path(), "new.txt").unwrap();
        assert!(loaded.payload.base.is_none());
        assert_eq!(loaded.payload.local, "from main\n");
        assert_eq!(loaded.payload.remote, "from feature\n");
    }

    #[test]
    fn conflicted_variant_serializes_camel_case_fields() {
        // `rename_all` on the enum itself only renames variant tags, not a
        // struct variant's own fields — this needs its own
        // `#[serde(rename_all = "camelCase")]` on `Conflicted`, so the
        // frontend sees `repoRoot`, matching every other payload type.
        let value = RepoScanResult::Conflicted {
            repo_root: "/x".into(),
            files: vec![],
        };
        let json = serde_json::to_string(&value).unwrap();
        assert!(json.contains("repoRoot"), "json was: {json}");
    }
}
