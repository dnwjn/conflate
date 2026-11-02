use std::borrow::Cow;
use std::ops::Range;

use similar::{DiffTag, TextDiff};

use super::types::{Hunk, HunkKind, MergeError, ThreeWayMergeResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Side {
    Local,
    Remote,
}

/// A maximal run of non-equal ops from one side's diff against base,
/// expressed in base-line coordinates plus that side's line coordinates.
#[derive(Debug, Clone)]
struct ChangeRegion {
    side: Side,
    base: Range<usize>,
    side_range: Range<usize>,
}

/// The single line tokenizer of this module: lines end at `\n` only (each
/// line keeps its terminator). A lone `\r` is ordinary line content, as in
/// git.
///
/// Every line index this module handles refers into vectors built by this
/// function, and `similar` diffs these exact vectors (`TextDiff::from_slices`
/// in `change_regions`), so the two can never disagree about line
/// boundaries. Do NOT use `TextDiff::from_lines` here: it splits on a lone
/// `\r` too, which desynced line indices and silently dropped edits.
fn split_lines(text: &str) -> Vec<&str> {
    text.split_inclusive('\n').collect()
}

fn change_regions(side: Side, base: &[&str], other: &[&str]) -> Vec<ChangeRegion> {
    let diff = TextDiff::from_slices(base, other);
    let mut regions: Vec<ChangeRegion> = Vec::new();
    for op in diff.ops() {
        let (tag, old, new) = op.as_tag_tuple();
        if tag == DiffTag::Equal {
            continue;
        }
        match regions.last_mut() {
            Some(last) if last.base.end == old.start && last.side_range.end == new.start => {
                last.base.end = old.end;
                last.side_range.end = new.end;
            }
            _ => regions.push(ChangeRegion {
                side,
                base: old,
                side_range: new,
            }),
        }
    }
    regions
}

/// Base-coordinate range intersection test (same family as `diff3`).
///
/// Ranges are half-open over base line indices. A pure insertion has an empty
/// range `p..p`, anchored *between* base lines `p - 1` and `p`.
///
/// - Two non-empty ranges overlap iff they share at least one base line
///   (strict intersection; merely touching ranges do not overlap).
/// - Two insertions overlap iff they are anchored at the same point: their
///   relative order would be ambiguous.
/// - An insertion overlaps a non-empty range iff it is anchored inside it
///   *or at either edge* (`s <= p <= e`), matching git's conservative
///   behaviour. At an edge, whether the insertion lands before or after the
///   other side's block depends on how the diff happened to align repeated
///   lines (e.g. both sides adding `}` there), so auto-merging would pick an
///   arbitrary order or duplicate a line. That is a conflict for the user.
fn overlaps(a: &Range<usize>, b: &Range<usize>) -> bool {
    match (a.is_empty(), b.is_empty()) {
        (false, false) => a.start < b.end && b.start < a.end,
        (true, true) => a.start == b.start,
        (true, false) => b.start <= a.start && a.start <= b.end,
        (false, true) => a.start <= b.start && b.start <= a.end,
    }
}

/// A group of change regions (from either side) whose base ranges overlap.
#[derive(Debug)]
struct Cluster {
    base: Range<usize>,
    regions: Vec<ChangeRegion>,
}

fn cluster_regions(mut regions: Vec<ChangeRegion>) -> Vec<Cluster> {
    regions.sort_by_key(|r| (r.base.start, r.base.end));
    let mut clusters: Vec<Cluster> = Vec::new();
    for region in regions {
        match clusters.last_mut() {
            // Test the members too, not just the union: the union `s..e`
            // hides that a member is an insertion anchored at `e`, which a
            // region starting at `e` must join (edge-adjacent insertion).
            Some(c)
                if overlaps(&c.base, &region.base)
                    || c.regions.iter().any(|m| overlaps(&m.base, &region.base)) =>
            {
                c.base.end = c.base.end.max(region.base.end);
                c.regions.push(region);
            }
            _ => clusters.push(Cluster {
                base: region.base.clone(),
                regions: vec![region],
            }),
        }
    }
    clusters
}

/// The lines `side` has in place of base range `cluster.base`. Between the
/// cluster edges and that side's first/last region the side equals base, so
/// the side range is the side's regions widened by those equal stretches.
/// Returns `None` when `side` made no change inside the cluster.
fn side_span(cluster: &Cluster, side: Side) -> Result<Option<Range<usize>>, MergeError> {
    let mut iter = cluster.regions.iter().filter(|r| r.side == side);
    let Some(first) = iter.next() else {
        return Ok(None);
    };
    let last = iter.next_back().unwrap_or(first);
    let invariant = || {
        MergeError::InternalInvariant(format!(
            "side span of {side:?} region(s) {first:?}..{last:?} escapes cluster {:?}",
            cluster.base
        ))
    };
    let lead = first
        .base
        .start
        .checked_sub(cluster.base.start)
        .ok_or_else(invariant)?;
    let trail = cluster
        .base
        .end
        .checked_sub(last.base.end)
        .ok_or_else(invariant)?;
    let start = first
        .side_range
        .start
        .checked_sub(lead)
        .ok_or_else(invariant)?;
    let end = last.side_range.end + trail;
    Ok(Some(start..end))
}

/// `lines[range]`, failing loudly (in debug *and* release) when the range is
/// out of bounds. Ranges are in bounds by construction (they come from
/// `similar`'s ops over these exact line vectors, or from cursors that tile
/// the input), so an out-of-bounds range is a bug. It must never degrade to
/// an empty or truncated slice: that silently drops content from the merge
/// result the user is about to save.
fn slice<'a, 'b>(lines: &'b [&'a str], range: Range<usize>) -> Result<&'b [&'a str], MergeError> {
    let len = lines.len();
    lines.get(range.clone()).ok_or_else(|| {
        MergeError::InternalInvariant(format!(
            "line range {range:?} out of bounds for {len} lines"
        ))
    })
}

/// Which pane's text a hunk places into the result.
#[derive(Clone, Copy)]
enum Pick {
    Base,
    Local,
    Remote,
}

/// Accumulates hunks and the auto-merged text, tracking line offsets in the
/// result, local and remote panes. Hunks are pushed in order and tile every
/// pane, so each pane's offset is just the running sum of hunk lengths.
#[derive(Default)]
struct ResultBuilder {
    hunks: Vec<Hunk>,
    merged: String,
    merged_line: usize,
    base_line: usize,
    local_line: usize,
    remote_line: usize,
    conflict_count: usize,
}

impl ResultBuilder {
    fn push(&mut self, kind: HunkKind, base: &[&str], local: &[&str], remote: &[&str], pick: Pick) {
        let picked = match pick {
            Pick::Base => base,
            Pick::Local => local,
            Pick::Remote => remote,
        };
        let merged_text = picked.concat();
        self.merged.push_str(&merged_text);
        let hunk = Hunk {
            start_line: self.merged_line,
            end_line: self.merged_line + picked.len(),
            kind,
            local_start_line: self.local_line,
            local_end_line: self.local_line + local.len(),
            remote_start_line: self.remote_line,
            remote_end_line: self.remote_line + remote.len(),
            base_text: base.concat(),
            local_text: local.concat(),
            remote_text: remote.concat(),
            merged_text,
        };
        self.merged_line = hunk.end_line;
        self.base_line += base.len();
        self.local_line = hunk.local_end_line;
        self.remote_line = hunk.remote_end_line;
        if kind == HunkKind::Conflict {
            self.conflict_count += 1;
        }
        self.hunks.push(hunk);
    }

    /// A region where base, local and remote all hold the same lines.
    fn push_unchanged(&mut self, lines: &[&str]) {
        self.push(HunkKind::Unchanged, lines, lines, lines, Pick::Base);
    }

    /// Final cross-check that the hunks tiled every pane completely: each
    /// pane's running line offset must land exactly on its line count. A
    /// mismatch means lines were dropped or duplicated, which must fail
    /// loudly rather than reach the user's result file.
    fn finish(
        self,
        local: &[&str],
        remote: &[&str],
        base: Option<&[&str]>,
    ) -> Result<ThreeWayMergeResult, MergeError> {
        let checks = [
            ("local", self.local_line, local.len()),
            ("remote", self.remote_line, remote.len()),
            ("base", self.base_line, base.map_or(0, <[&str]>::len)),
        ];
        for (pane, covered, total) in checks {
            if covered != total {
                return Err(MergeError::InternalInvariant(format!(
                    "hunks cover {covered} of {total} {pane} lines"
                )));
            }
        }
        Ok(ThreeWayMergeResult {
            hunks: self.hunks,
            auto_merged_text: self.merged,
            conflict_count: self.conflict_count,
        })
    }
}

/// Normalize CRLF line endings to LF so line-ending-only differences never
/// register as changes (and so can never manufacture a false conflict).
/// A lone `\r` not followed by `\n` is left untouched.
fn normalize_line_endings(text: &str) -> Cow<'_, str> {
    if text.contains("\r\n") {
        Cow::Owned(text.replace("\r\n", "\n"))
    } else {
        Cow::Borrowed(text)
    }
}

/// Base-anchored 3-way merge of `local` and `remote` against their common
/// ancestor `base` (same family as `git merge-file` / `diff3`).
///
/// Non-overlapping changes from either side are applied automatically,
/// identical changes on both sides are applied once, and changes where both
/// sides diverge differently in overlapping base ranges become `Conflict`
/// hunks, seeded in `auto_merged_text` with local's version ("ours first").
/// `base: None` or an empty base (no common ancestor, e.g. add/add) falls
/// back to a 2-way diff of local vs remote in which every differing region
/// is a conflict.
///
/// **Known limitation:** because an empty base is indistinguishable from a
/// missing one, a genuine empty-file ancestor where one side stayed empty
/// and the other added content becomes a conflict instead of auto-applying
/// the addition. Git does not produce this case in practice (it is an
/// add/add or a modify of an empty file, both rare), so v1 accepts it.
///
/// **Line splitting:** lines end at `\n` only; a lone `\r` (not followed by
/// `\n`) is ordinary line content and is preserved byte-for-byte.
///
/// **Errors:** returns `Err(MergeError::InternalInvariant(_))` only if an
/// internal invariant is violated (a bug in this module, e.g. a line range
/// out of bounds). It never returns a silently wrong or truncated merge.
///
/// **Line endings:** all three inputs are normalized from CRLF to LF before
/// diffing, so `auto_merged_text` and every hunk use LF only. Original line
/// endings are *not* preserved in v1 (acceptable for the text-files-only
/// scope; to be documented in the README).
pub fn compute_three_way_merge(
    base: Option<&str>,
    local: &str,
    remote: &str,
) -> Result<ThreeWayMergeResult, MergeError> {
    let local = normalize_line_endings(local);
    let remote = normalize_line_endings(remote);
    match base {
        // `git mergetool` materializes an absent base (add/add) as an empty
        // file, so an empty base is treated exactly like a missing one.
        Some(base) if !base.is_empty() => {
            merge_with_base(&normalize_line_endings(base), &local, &remote)
        }
        _ => merge_without_base(&local, &remote),
    }
}

/// No common ancestor (e.g. add/add): a plain 2-way diff of local vs remote.
/// Lines both sides share are `Unchanged`; each differing region is one
/// `Conflict` (seeded with local's version) spanning just that region.
/// `base_text` is empty for every hunk.
fn merge_without_base(local: &str, remote: &str) -> Result<ThreeWayMergeResult, MergeError> {
    let local_lines = split_lines(local);
    let remote_lines = split_lines(remote);
    // Reuse region extraction with local playing the role of "base": each
    // region's `base` range is in local lines, `side_range` in remote lines.
    let regions = change_regions(Side::Remote, &local_lines, &remote_lines);

    let mut out = ResultBuilder::default();
    let mut cursor = 0usize;
    for region in &regions {
        if region.base.start > cursor {
            let common = slice(&local_lines, cursor..region.base.start)?;
            out.push(HunkKind::Unchanged, &[], common, common, Pick::Local);
        }
        out.push(
            HunkKind::Conflict,
            &[],
            slice(&local_lines, region.base.clone())?,
            slice(&remote_lines, region.side_range.clone())?,
            Pick::Local,
        );
        cursor = region.base.end;
    }
    if cursor < local_lines.len() {
        let common = slice(&local_lines, cursor..local_lines.len())?;
        out.push(HunkKind::Unchanged, &[], common, common, Pick::Local);
    }
    out.finish(&local_lines, &remote_lines, None)
}

fn merge_with_base(
    base: &str,
    local: &str,
    remote: &str,
) -> Result<ThreeWayMergeResult, MergeError> {
    let base_lines = split_lines(base);
    let local_lines = split_lines(local);
    let remote_lines = split_lines(remote);

    let mut regions = change_regions(Side::Local, &base_lines, &local_lines);
    regions.extend(change_regions(Side::Remote, &base_lines, &remote_lines));
    let clusters = cluster_regions(regions);

    let mut out = ResultBuilder::default();
    let mut cursor = 0usize;
    for cluster in &clusters {
        if cluster.base.start > cursor {
            out.push_unchanged(slice(&base_lines, cursor..cluster.base.start)?);
        }
        let base_part = slice(&base_lines, cluster.base.clone())?;
        // A side with no change inside the cluster holds base's lines there.
        let local_span = side_span(cluster, Side::Local)?;
        let remote_span = side_span(cluster, Side::Remote)?;
        let local_part = match local_span.clone() {
            Some(r) => slice(&local_lines, r)?,
            None => base_part,
        };
        let remote_part = match remote_span.clone() {
            Some(r) => slice(&remote_lines, r)?,
            None => base_part,
        };
        let (kind, pick) = match (local_span, remote_span) {
            (Some(_), None) => (HunkKind::LocalOnly, Pick::Local),
            (None, Some(_)) => (HunkKind::RemoteOnly, Pick::Remote),
            (Some(_), Some(_)) if local_part == remote_part => (HunkKind::SameChange, Pick::Local),
            // Both sides diverged differently inside overlapping base ranges:
            // a true conflict. Seed the result with local ("ours first").
            (Some(_), Some(_)) => (HunkKind::Conflict, Pick::Local),
            // Unreachable: every cluster holds at least one region.
            (None, None) => (HunkKind::Unchanged, Pick::Base),
        };
        out.push(kind, base_part, local_part, remote_part, pick);
        cursor = cluster.base.end;
    }
    if cursor < base_lines.len() {
        out.push_unchanged(slice(&base_lines, cursor..base_lines.len())?);
    }
    out.finish(&local_lines, &remote_lines, Some(&base_lines))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[allow(clippy::reversed_empty_ranges)] // a reversed range is one of the bad inputs
    fn slice_out_of_bounds_is_an_error_not_an_empty_slice() {
        let lines = ["a\n", "b\n"];
        assert_eq!(slice(&lines, 0..2).unwrap(), &lines[..]);
        assert_eq!(slice(&lines, 2..2).unwrap(), &[] as &[&str]);
        for bad in [1..3, 3..3, 2..1] {
            assert!(
                matches!(
                    slice(&lines, bad.clone()),
                    Err(MergeError::InternalInvariant(_))
                ),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn finish_rejects_incomplete_tiling() {
        let mut out = ResultBuilder::default();
        out.push_unchanged(&["a\n"]);
        let lines = ["a\n", "b\n"];
        assert!(matches!(
            out.finish(&lines, &lines, Some(&lines)),
            Err(MergeError::InternalInvariant(_))
        ));
    }
}
