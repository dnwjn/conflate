//! Serializable result types of the 3-way merge (mirrored to TypeScript).

use serde::{Deserialize, Serialize};
use specta::Type;

/// How a hunk was classified by the 3-way merge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum HunkKind {
    /// Neither side changed this region; base is copied through.
    Unchanged,
    /// Only local changed it; local's version was auto-applied.
    LocalOnly,
    /// Only remote changed it; remote's version was auto-applied.
    RemoteOnly,
    /// Both sides made the identical change; applied once.
    SameChange,
    /// Both sides changed overlapping base ranges differently. The result is
    /// seeded with local's version; the user must resolve it.
    Conflict,
}

/// One contiguous region of the merge, in the coordinates of every pane.
///
/// All line ranges are **0-based and half-open** (`start..end`), so an empty
/// range (`start == end`) means "zero lines at this position", e.g. a
/// conflict where local deleted the lines remote modified.
///
/// The hunks of a result tile each pane exactly: concatenating `merged_text`
/// over all hunks gives `auto_merged_text`, and likewise `local_text`,
/// `remote_text` and `base_text` reconstruct the (LF-normalized) inputs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct Hunk {
    /// Line range in the result (`auto_merged_text`).
    ///
    /// Exported to TypeScript as `number` (via `specta_typescript::Number`)
    /// rather than `bigint`: these are line indices into merge input files,
    /// nowhere near `Number.MAX_SAFE_INTEGER`, so the precision loss Specta
    /// otherwise guards `usize`/`u64` against does not apply.
    #[specta(type = specta_typescript::Number)]
    pub start_line: usize,
    #[specta(type = specta_typescript::Number)]
    pub end_line: usize,
    pub kind: HunkKind,
    /// Line range in local.
    #[specta(type = specta_typescript::Number)]
    pub local_start_line: usize,
    #[specta(type = specta_typescript::Number)]
    pub local_end_line: usize,
    /// Line range in remote.
    #[specta(type = specta_typescript::Number)]
    pub remote_start_line: usize,
    #[specta(type = specta_typescript::Number)]
    pub remote_end_line: usize,
    /// Base's text for this region (empty when there is no base).
    pub base_text: String,
    /// Local's text for this region.
    pub local_text: String,
    /// Remote's text for this region.
    pub remote_text: String,
    /// Text placed in the result for this region (local's for a `Conflict`).
    pub merged_text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ThreeWayMergeResult {
    pub hunks: Vec<Hunk>,
    /// The merged text: every non-conflicting change applied, conflicts
    /// seeded with local's version. No conflict marker text is inserted.
    pub auto_merged_text: String,
    #[specta(type = specta_typescript::Number)]
    pub conflict_count: usize,
}

/// Why `compute_three_way_merge` refused to produce a result.
///
/// The merge has no user-facing failure modes: every input pair/triple of
/// strings is mergeable. The only error is a violated internal invariant
/// (a bug in this module), reported loudly instead of returning a silently
/// wrong merge that would then be written to the user's result file.
/// Whether a word-level diff segment is unchanged, inserted, or deleted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum WordDiffKind {
    Equal,
    Insert,
    Delete,
}

/// One segment of a word-level diff between two strings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct WordDiffOp {
    pub kind: WordDiffKind,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum MergeError {
    /// An internal invariant was violated (e.g. a line range out of bounds).
    /// The message describes which one. This always indicates a bug.
    InternalInvariant(String),
}

impl std::fmt::Display for MergeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MergeError::InternalInvariant(msg) => {
                write!(f, "internal 3-way merge invariant violated: {msg}")
            }
        }
    }
}

impl std::error::Error for MergeError {}
