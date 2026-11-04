use std::path::Path;
use std::process::Command;

/// Best-effort LOCAL/REMOTE pane labels, read by shelling out to `git`
/// itself. Git's mergetool protocol only ever hands us the `$BASE`/`$LOCAL`/
/// `$REMOTE`/`$MERGED` temp file *paths* (see `cli.rs`) — it never exposes
/// branch names — so this is the only way to recover them.
///
/// Runs from `dir`, which should be the process's current directory (the cwd
/// `git mergetool` launched us in — normally the repo root). Any failure
/// here (not a git repo, `git` not on `$PATH`, detached `HEAD`, no
/// merge/rebase/cherry-pick in progress) leaves the corresponding label
/// `None`; the frontend already falls back to "HEAD" / no label for that
/// case (see `ThreeWayViewOptions.localLabel`/`.remoteLabel`).
pub fn detect_branch_labels(dir: &Path) -> (Option<String>, Option<String>) {
    let local = run_git(dir, &["symbolic-ref", "--short", "HEAD"])
        .or_else(|| run_git(dir, &["rev-parse", "--short", "HEAD"]));
    // Tried in this order since only one of these refs can exist at a time
    // for a given conflict: a plain `git merge` sets `MERGE_HEAD`, `git
    // cherry-pick` sets `CHERRY_PICK_HEAD`, and `git rebase` sets
    // `REBASE_HEAD` (recent git versions; older ones have no equivalent, so
    // this simply yields `None` there).
    let remote = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REBASE_HEAD"]
        .iter()
        .find_map(|head| run_git(dir, &["name-rev", "--name-only", "--no-undefined", head]));
    (local, remote)
}

/// Runs `git` with `args`, returning its trimmed stdout on success. `None`
/// on any failure: nonzero exit, `git` missing, or empty/non-UTF-8 output.
fn run_git(dir: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).current_dir(dir).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_non_git_directory_yields_no_labels() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(detect_branch_labels(dir.path()), (None, None));
    }
}
