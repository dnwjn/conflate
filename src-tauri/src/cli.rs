use clap::Parser;
use std::fmt;
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};

/// Positional arguments passed by git's mergetool machinery:
/// `conflate <base> <local> <remote> <merged>`.
#[derive(Parser, Debug, Clone, PartialEq, Eq)]
#[command(
    name = "conflate",
    about = "Resolve a merge conflict in a git mergetool session",
    version
)]
pub struct Args {
    /// Common ancestor version. May not exist on disk (add/add conflicts).
    pub base: PathBuf,
    /// Local (ours) version. Must exist and be readable.
    pub local: PathBuf,
    /// Remote (theirs) version. Must exist and be readable.
    pub remote: PathBuf,
    /// Where the resolved result is written.
    pub merged: PathBuf,
}

/// What `main.rs` found on the command line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchMode {
    /// `git mergetool`-style invocation: exactly 4 valid, readable args.
    Merge(Args),
    /// No positional args at all — launched directly (double-click, Dock,
    /// Spotlight) rather than by git's mergetool machinery.
    Empty,
}

#[derive(Debug)]
pub enum CliError {
    /// `--help` was requested. Not an error: the text goes to stdout, exit 0.
    Help(String),
    /// `--version` was requested. Not an error: the text goes to stdout, exit 0.
    Version(String),
    /// Clap rejected the argument list (wrong count, unknown flag, ...).
    Usage(String),
    /// A required input file does not exist.
    MissingInput { role: &'static str, path: PathBuf },
    /// A required input file exists but cannot be opened for reading.
    Unreadable {
        role: &'static str,
        path: PathBuf,
        source: io::Error,
    },
}

impl fmt::Display for CliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CliError::Help(text) | CliError::Version(text) => write!(f, "{}", text.trim_end()),
            CliError::Usage(msg) => write!(f, "{}", msg.trim_end()),
            CliError::MissingInput { role, path } => {
                write!(
                    f,
                    "conflate: {role} file does not exist: {}",
                    path.display()
                )
            }
            CliError::Unreadable { role, path, source } => {
                write!(
                    f,
                    "conflate: cannot read {role} file {}: {source}",
                    path.display()
                )
            }
        }
    }
}

impl std::error::Error for CliError {}

/// Parses `argv` (including the program name at index 0) and validates that
/// the `local` and `remote` inputs can be read. `base` is intentionally not
/// checked: a missing base signals the empty-base (add/add) case.
///
/// `argv` with nothing but the program name (no positional args, no flags —
/// the shape of a double-click/Dock/Spotlight launch) is `LaunchMode::Empty`,
/// not an error: conflate still opens a window in that case and lets the
/// frontend show the repo-browser empty state instead of exiting. Anything
/// else that isn't exactly 4 valid, readable positional args (1-3 args, bad
/// flags, unreadable local/remote) is still a `CliError`, exactly as before.
pub fn parse_args(argv: &[String]) -> Result<LaunchMode, CliError> {
    if argv.len() == 1 {
        return Ok(LaunchMode::Empty);
    }
    let args = Args::try_parse_from(argv).map_err(|e| {
        use clap::error::ErrorKind;
        match e.kind() {
            ErrorKind::DisplayHelp => CliError::Help(e.to_string()),
            ErrorKind::DisplayVersion => CliError::Version(e.to_string()),
            _ => CliError::Usage(e.to_string()),
        }
    })?;
    check_readable("local", &args.local)?;
    check_readable("remote", &args.remote)?;
    Ok(LaunchMode::Merge(args))
}

fn check_readable(role: &'static str, path: &Path) -> Result<(), CliError> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(source) if source.kind() == io::ErrorKind::NotFound => {
            return Err(CliError::MissingInput {
                role,
                path: path.to_path_buf(),
            });
        }
        Err(source) => {
            return Err(CliError::Unreadable {
                role,
                path: path.to_path_buf(),
                source,
            });
        }
    };
    if !metadata.is_file() {
        let source = io::Error::other("not a regular file");
        return Err(CliError::Unreadable {
            role,
            path: path.to_path_buf(),
            source,
        });
    }
    File::open(path)
        .map(|_| ())
        .map_err(|source| CliError::Unreadable {
            role,
            path: path.to_path_buf(),
            source,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_args_is_empty_launch_mode() {
        let argv = vec!["conflate".into()];
        assert!(matches!(parse_args(&argv), Ok(LaunchMode::Empty)));
    }

    #[test]
    fn parses_four_positional_args() {
        // local/remote must exist, so create real files (brief used bare names, which now fail validation).
        let dir = tempfile::tempdir().unwrap();
        let local = dir.path().join("local.txt");
        let remote = dir.path().join("remote.txt");
        std::fs::write(&local, "local").unwrap();
        std::fs::write(&remote, "remote").unwrap();
        let argv = vec![
            "conflate".into(),
            "base.txt".into(),
            local.to_str().unwrap().into(),
            remote.to_str().unwrap().into(),
            "merged.txt".into(),
        ];
        let mode = parse_args(&argv).unwrap();
        match mode {
            LaunchMode::Merge(args) => assert_eq!(args.local, local),
            LaunchMode::Empty => panic!("expected LaunchMode::Merge, got Empty"),
        }
    }

    #[test]
    fn rejects_wrong_arg_count() {
        let argv = vec!["conflate".into(), "only_one.txt".into()];
        assert!(parse_args(&argv).is_err());
    }

    #[test]
    fn help_flag_is_not_a_usage_error() {
        let argv = vec!["conflate".into(), "--help".into()];
        match parse_args(&argv) {
            Err(CliError::Help(text)) => assert!(text.contains("Usage:"), "help text: {text}"),
            other => panic!("expected CliError::Help, got {other:?}"),
        }
    }

    #[test]
    fn version_flag_is_not_a_usage_error() {
        let argv = vec!["conflate".into(), "--version".into()];
        match parse_args(&argv) {
            Err(CliError::Version(text)) => {
                assert!(text.contains("conflate"), "version text: {text}")
            }
            other => panic!("expected CliError::Version, got {other:?}"),
        }
    }

    #[test]
    fn wrong_arg_count_is_a_usage_error() {
        let argv = vec!["conflate".into(), "only_one.txt".into()];
        assert!(matches!(parse_args(&argv), Err(CliError::Usage(_))));
    }

    #[test]
    fn rejects_directory_as_local_input() {
        let dir = tempfile::tempdir().unwrap();
        let remote = dir.path().join("remote.txt");
        std::fs::write(&remote, "remote").unwrap();
        let argv = vec![
            "conflate".into(),
            "base.txt".into(),
            dir.path().to_str().unwrap().into(),
            remote.to_str().unwrap().into(),
            "merged.txt".into(),
        ];
        match parse_args(&argv) {
            Err(CliError::Unreadable { role, .. }) => assert_eq!(role, "local"),
            other => panic!("expected Unreadable for a directory, got {other:?}"),
        }
    }

    #[test]
    fn rejects_nonexistent_local_or_remote_path() {
        // local/remote must exist; base may legitimately be absent (empty-base case)
        let dir = tempfile::tempdir().unwrap();
        let argv = vec![
            "conflate".into(),
            dir.path().join("base.txt").to_str().unwrap().into(),
            dir.path()
                .join("missing_local.txt")
                .to_str()
                .unwrap()
                .into(),
            dir.path()
                .join("missing_remote.txt")
                .to_str()
                .unwrap()
                .into(),
            dir.path().join("merged.txt").to_str().unwrap().into(),
        ];
        assert!(parse_args(&argv).is_err());
    }
}
