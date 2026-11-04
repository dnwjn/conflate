use conflate_lib::diff::three_way;
use conflate_lib::diff::types::{HunkKind, ThreeWayMergeResult};

/// The merge only errors on an internal-invariant violation (a bug), so every
/// test input must merge successfully.
fn compute_three_way_merge(base: Option<&str>, local: &str, remote: &str) -> ThreeWayMergeResult {
    three_way::compute_three_way_merge(base, local, remote)
        .unwrap_or_else(|e| panic!("merge failed for {base:?} / {local:?} / {remote:?}: {e}"))
}

#[test]
fn identical_inputs_yield_zero_conflicts() {
    let result = compute_three_way_merge(Some("a\nb\nc\n"), "a\nb\nc\n", "a\nb\nc\n");
    assert_eq!(result.conflict_count, 0);
    assert_eq!(result.auto_merged_text, "a\nb\nc\n");
}

#[test]
fn local_only_change_auto_applies() {
    let result = compute_three_way_merge(Some("a\nb\nc\n"), "a\nX\nc\n", "a\nb\nc\n");
    assert_eq!(result.conflict_count, 0);
    assert_eq!(result.auto_merged_text, "a\nX\nc\n");
}

#[test]
fn same_change_on_both_sides_auto_applies() {
    let result = compute_three_way_merge(Some("a\nb\nc\n"), "a\nX\nc\n", "a\nX\nc\n");
    assert_eq!(result.conflict_count, 0);
    assert_eq!(result.auto_merged_text, "a\nX\nc\n");
}

#[test]
fn overlapping_different_edits_conflict() {
    let result = compute_three_way_merge(Some("a\nb\nc\n"), "a\nX\nc\n", "a\nY\nc\n");
    assert_eq!(result.conflict_count, 1);
    assert_eq!(
        result
            .hunks
            .iter()
            .find(|h| h.kind == HunkKind::Conflict)
            .unwrap()
            .kind,
        HunkKind::Conflict
    );
}

#[test]
fn adjacent_non_overlapping_edits_do_not_conflict() {
    // local changes line 2, remote changes line 4 — base-coordinate ranges don't intersect
    let result = compute_three_way_merge(
        Some("a\nb\nc\nd\ne\n"),
        "a\nX\nc\nd\ne\n",
        "a\nb\nc\nY\ne\n",
    );
    assert_eq!(result.conflict_count, 0);
}

#[test]
fn simultaneous_insertion_at_same_point_conflicts() {
    let result = compute_three_way_merge(
        Some("a\nb\n"),
        "a\nINSERTED_LOCAL\nb\n",
        "a\nINSERTED_REMOTE\nb\n",
    );
    assert_eq!(result.conflict_count, 1);
}

#[test]
fn delete_on_one_side_modify_on_other_conflicts() {
    let result = compute_three_way_merge(Some("a\nb\nc\n"), "a\nc\n", "a\nX\nc\n");
    assert_eq!(result.conflict_count, 1);
}

#[test]
fn missing_base_treats_every_difference_as_conflict_candidate() {
    let result = compute_three_way_merge(None, "local content\n", "remote content\n");
    assert_eq!(result.conflict_count, 1);
}

#[test]
fn missing_base_with_identical_local_remote_is_not_a_conflict() {
    let result = compute_three_way_merge(None, "same\n", "same\n");
    assert_eq!(result.conflict_count, 0);
}

// Extra (beyond brief): with no base, only the region where local and remote
// actually differ is the conflict; common lines around it are not.
#[test]
fn missing_base_conflict_spans_only_the_differing_region() {
    let result = compute_three_way_merge(None, "a\nb\nc\n", "a\nX\nc\n");
    assert_eq!(result.conflict_count, 1);
    assert_eq!(result.auto_merged_text, "a\nb\nc\n");
    let conflict = result
        .hunks
        .iter()
        .find(|h| h.kind == HunkKind::Conflict)
        .unwrap();
    assert_eq!((conflict.start_line, conflict.end_line), (1, 2));
    assert!(
        result
            .hunks
            .iter()
            .filter(|h| h.kind != HunkKind::Conflict)
            .all(|h| h.kind == HunkKind::Unchanged)
    );
}

// Extra (beyond brief): git mergetool materializes an absent base as an empty
// file, so an empty base must behave like a missing one (add/add).
#[test]
fn empty_base_behaves_like_missing_base() {
    let result = compute_three_way_merge(Some(""), "a\nb\nc\n", "a\nX\nc\n");
    assert_eq!(
        result,
        compute_three_way_merge(None, "a\nb\nc\n", "a\nX\nc\n")
    );
    assert_eq!(result.conflict_count, 1);
}

#[test]
fn crlf_vs_lf_only_difference_is_not_a_conflict() {
    let result = compute_three_way_merge(Some("a\nb\n"), "a\r\nb\r\n", "a\nb\n");
    assert_eq!(
        result.conflict_count, 0,
        "line-ending-only differences must not count as conflicts"
    );
}

// Extra (beyond brief): a CRLF-only rewrite on one side must not collide with a
// real edit on the other side, and the merged text is LF-normalized.
#[test]
fn crlf_rewrite_on_one_side_does_not_conflict_with_real_edit_on_other() {
    let result = compute_three_way_merge(Some("a\nb\nc\n"), "a\r\nb\r\nc\r\n", "a\nX\nc\n");
    assert_eq!(result.conflict_count, 0);
    assert_eq!(result.auto_merged_text, "a\nX\nc\n");
}

#[test]
fn whole_file_rewrite_on_one_side_auto_applies() {
    let result = compute_three_way_merge(
        Some("a\nb\nc\n"),
        "totally\ndifferent\ncontent\nhere\n",
        "a\nb\nc\n",
    );
    assert_eq!(result.conflict_count, 0);
    assert_eq!(
        result.auto_merged_text,
        "totally\ndifferent\ncontent\nhere\n"
    );
}

// Extra (beyond brief): every hunk carries the text each pane shows for it.
#[test]
fn conflict_hunk_carries_base_local_remote_and_merged_text() {
    let result = compute_three_way_merge(Some("a\nb\nc\n"), "a\nX\nc\n", "a\nY\nc\n");
    let h = result
        .hunks
        .iter()
        .find(|h| h.kind == HunkKind::Conflict)
        .unwrap();
    assert_eq!(h.base_text, "b\n");
    assert_eq!(h.local_text, "X\n");
    assert_eq!(h.remote_text, "Y\n");
    assert_eq!(h.merged_text, "X\n");
    assert_eq!((h.start_line, h.end_line), (1, 2));
    assert_eq!((h.local_start_line, h.local_end_line), (1, 2));
    assert_eq!((h.remote_start_line, h.remote_end_line), (1, 2));
}

/// Hunks must tile every pane exactly: no duplicated or dropped lines.
fn assert_well_formed(base: Option<&str>, local: &str, remote: &str) {
    let norm = |s: &str| s.replace("\r\n", "\n");
    let result = compute_three_way_merge(base, local, remote);
    let cat = |f: fn(&conflate_lib::diff::types::Hunk) -> &str| {
        result.hunks.iter().map(f).collect::<String>()
    };
    let ctx = format!("base={base:?} local={local:?} remote={remote:?}");
    assert_eq!(cat(|h| &h.merged_text), result.auto_merged_text, "{ctx}");
    assert_eq!(cat(|h| &h.local_text), norm(local), "{ctx}");
    assert_eq!(cat(|h| &h.remote_text), norm(remote), "{ctx}");
    match base {
        Some(b) => assert_eq!(cat(|h| &h.base_text), norm(b), "{ctx}"),
        None => assert_eq!(cat(|h| &h.base_text), "", "{ctx}"),
    }
    let (mut m, mut l, mut r) = (0, 0, 0);
    for h in &result.hunks {
        assert_eq!(
            (h.start_line, h.local_start_line, h.remote_start_line),
            (m, l, r),
            "{ctx}"
        );
        assert_eq!(
            h.end_line - h.start_line,
            h.merged_text.lines().count(),
            "{ctx}"
        );
        assert_eq!(
            h.local_end_line - h.local_start_line,
            h.local_text.lines().count(),
            "{ctx}"
        );
        assert_eq!(
            h.remote_end_line - h.remote_start_line,
            h.remote_text.lines().count(),
            "{ctx}"
        );
        (m, l, r) = (h.end_line, h.local_end_line, h.remote_end_line);
    }
    assert_eq!(
        result.conflict_count,
        result
            .hunks
            .iter()
            .filter(|h| h.kind == HunkKind::Conflict)
            .count(),
        "{ctx}"
    );
}

#[test]
fn hunks_tile_all_panes_for_every_case() {
    let cases: &[(Option<&str>, &str, &str)] = &[
        (Some("a\nb\nc\n"), "a\nb\nc\n", "a\nb\nc\n"),
        (Some("a\nb\nc\n"), "a\nX\nc\n", "a\nb\nc\n"),
        (Some("a\nb\nc\n"), "a\nX\nc\n", "a\nX\nc\n"),
        (Some("a\nb\nc\n"), "a\nX\nc\n", "a\nY\nc\n"),
        (
            Some("a\nb\nc\nd\ne\n"),
            "a\nX\nc\nd\ne\n",
            "a\nb\nc\nY\ne\n",
        ),
        (
            Some("a\nb\n"),
            "a\nINSERTED_LOCAL\nb\n",
            "a\nINSERTED_REMOTE\nb\n",
        ),
        (Some("a\nb\nc\n"), "a\nc\n", "a\nX\nc\n"),
        (None, "local content\n", "remote content\n"),
        (None, "same\n", "same\n"),
        (None, "a\nb\nc\n", "a\nX\nc\n"),
        (Some("a\nb\n"), "a\r\nb\r\n", "a\nb\n"),
        (Some("a\nb\nc\n"), "a\r\nb\r\nc\r\n", "a\nX\nc\n"),
        (
            Some("a\nb\nc\n"),
            "totally\ndifferent\ncontent\nhere\n",
            "a\nb\nc\n",
        ),
        // edge shapes: empty inputs, missing trailing newline, insert at edges
        (Some(""), "", ""),
        (None, "", ""),
        (Some(""), "x\n", ""),
        (Some("a\nb"), "a\nb", "a\nc"),
        (Some("a\nb\n"), "top\na\nb\n", "a\nb\nbottom\n"),
        (Some("a\nb\nc\n"), "a\nL\nb\nc\n", "a\nb\nR\nc\n"),
        (Some("a\nb\nc\nd\n"), "a\nB\nC\nd\n", "a\nb\nC\nD\n"),
    ];
    for &(b, l, r) in cases {
        assert_well_formed(b, l, r);
    }
}

// Policy (controller ruling on review finding): an insertion anchored exactly
// at the boundary of the other side's changed block DOES conflict, like git.
// Otherwise the merged order of the two sides' lines at that boundary is an
// arbitrary artifact of how `similar` aligned the diff.
#[test]
fn insertion_at_edge_of_other_sides_change_conflicts() {
    let before = compute_three_way_merge(Some("a\nb\nc\n"), "a\nI\nb\nc\n", "a\nX\nc\n");
    assert_eq!(before.conflict_count, 1);
    let after = compute_three_way_merge(Some("a\nb\nc\n"), "a\nb\nI\nc\n", "a\nX\nc\n");
    assert_eq!(after.conflict_count, 1);
    // An insertion strictly inside the other side's changed block conflicts too.
    let inside = compute_three_way_merge(Some("a\nb\nc\nd\n"), "a\nb\nI\nc\nd\n", "a\nX\nY\nd\n");
    assert_eq!(inside.conflict_count, 1);
    for (b, l, r) in [
        ("a\nb\nc\n", "a\nI\nb\nc\n", "a\nX\nc\n"),
        ("a\nb\nc\n", "a\nb\nI\nc\n", "a\nX\nc\n"),
    ] {
        assert_well_formed(Some(b), l, r);
    }
}

// The review's order-dependence case: both sides independently add the same
// repeated-looking line (`}`) at the same boundary, one of them alongside an
// edit. Without a conflict the result silently duplicates or reorders `}`.
#[test]
fn both_sides_inserting_at_same_boundary_conflicts() {
    let result = compute_three_way_merge(Some("a\nb\n"), "a\n}\nb\n", "a\n}\nB\n");
    assert!(result.conflict_count >= 1, "{result:?}");
    let result = compute_three_way_merge(Some("a\nb\n"), "a\n\nb\n", "A\n\nb\n");
    assert!(result.conflict_count >= 1, "{result:?}");
    assert_well_formed(Some("a\nb\n"), "a\n}\nb\n", "a\n}\nB\n");
    assert_well_formed(Some("a\nb\n"), "a\n\nb\n", "A\n\nb\n");
}

// The ruling only affects insertions touching the other side's change. An
// insertion separated from the other side's edit by an unchanged base line,
// and two non-empty edits that merely touch, still merge cleanly.
#[test]
fn separated_insertion_and_touching_edits_still_do_not_conflict() {
    let result = compute_three_way_merge(Some("a\nb\nc\n"), "a\nI\nb\nc\n", "a\nb\nX\n");
    assert_eq!(result.conflict_count, 0);
    assert_eq!(result.auto_merged_text, "a\nI\nb\nX\n");
    let result = compute_three_way_merge(Some("a\nb\nc\nd\n"), "a\nB\nc\nd\n", "a\nb\nC\nd\n");
    assert_eq!(result.conflict_count, 0);
    assert_eq!(result.auto_merged_text, "a\nB\nC\nd\n");
}

// Regression (review finding, Critical): `similar::TextDiff::from_lines` treats
// a lone `\r` as a line terminator, while this module split only on `\n`. The
// two line-index spaces desynced, and in release builds local's edit to the
// last line silently vanished (0 conflicts). Lone `\r` in base, local and
// remote must be kept as ordinary line content and every edit must survive.
#[test]
fn lone_carriage_return_does_not_drop_edits() {
    // The exact reproduction from the review.
    let result = compute_three_way_merge(Some("a\rb\nc\nd\n"), "a\rb\nc\nX\n", "a\rb\nc\nd\n");
    assert_eq!(result.conflict_count, 0);
    assert_eq!(result.auto_merged_text, "a\rb\nc\nX\n");

    // Lone `\r` in all three inputs, non-overlapping edits on both sides.
    let base = "a\rb\nc\rd\ne\nf\rg\nh\n";
    let local = "a\rb\nc\rd\nE\nf\rg\nh\n";
    let remote = "a\rb\nc\rd\ne\nf\rg\nH\r\n";
    let result = compute_three_way_merge(Some(base), local, remote);
    assert_eq!(result.conflict_count, 0);
    assert_eq!(result.auto_merged_text, "a\rb\nc\rd\nE\nf\rg\nH\n");
    assert_well_formed(Some(base), local, remote);

    // Same with no base (2-way path).
    assert_well_formed(None, "a\rb\nc\nX\n", "a\rb\nc\nd\n");
    let result = compute_three_way_merge(None, "a\rb\nc\nX\n", "a\rb\nc\nd\n");
    assert_eq!(result.conflict_count, 1);
    assert_eq!(result.auto_merged_text, "a\rb\nc\nX\n");
}

// Pins the exact hunks the frontend's lone-`\r` regression tests
// (`src/merge/threeWayView.test.ts`, `crInput`/`crResult`) hand-construct, so
// the TS fixture can't silently drift from what this module really returns.
// The frontend must count lines exactly like this (on `\n` only) or the line
// indices below would point at the wrong CodeMirror lines.
#[test]
fn lone_cr_line_indices_match_frontend_fixture() {
    let result = compute_three_way_merge(Some("p\rq\nL\n"), "p\rq\nLOCAL\n", "p\rq\nREMOTE\n");
    assert_eq!(result.auto_merged_text, "p\rq\nLOCAL\n");
    assert_eq!(result.conflict_count, 1);
    let shape: Vec<_> = result
        .hunks
        .iter()
        .map(|h| {
            (
                h.kind,
                h.start_line,
                h.end_line,
                h.local_text.as_str(),
                h.remote_text.as_str(),
            )
        })
        .collect();
    assert_eq!(
        shape,
        vec![
            (HunkKind::Unchanged, 0, 1, "p\rq\n", "p\rq\n"),
            (HunkKind::Conflict, 1, 2, "LOCAL\n", "REMOTE\n"),
        ]
    );
}

// Pins the delete-vs-modify fixture used by the frontend's zero-width-conflict
// keyboard tests (`src/app.test.ts`, `deleteVsModifyResult`): the conflict
// is ZERO-WIDTH in the result (local deleted the line) and is immediately
// followed by an Unchanged hunk starting at the same result line.
#[test]
fn delete_vs_modify_fixture_has_zero_width_conflict_then_unchanged_at_same_line() {
    let result = compute_three_way_merge(Some("a\nb\nc\nd\n"), "a\nc\nD1\n", "a\nB\nc\nD2\n");
    assert_eq!(result.auto_merged_text, "a\nc\nD1\n");
    assert_eq!(result.conflict_count, 2);
    let shape: Vec<_> = result
        .hunks
        .iter()
        .map(|h| {
            (
                h.kind,
                h.start_line,
                h.end_line,
                (h.local_start_line, h.local_end_line),
                (h.remote_start_line, h.remote_end_line),
                h.local_text.as_str(),
                h.remote_text.as_str(),
            )
        })
        .collect();
    assert_eq!(
        shape,
        vec![
            (HunkKind::Unchanged, 0, 1, (0, 1), (0, 1), "a\n", "a\n"),
            (HunkKind::Conflict, 1, 1, (1, 1), (1, 2), "", "B\n"),
            (HunkKind::Unchanged, 1, 2, (1, 2), (2, 3), "c\n", "c\n"),
            (HunkKind::Conflict, 2, 3, (2, 3), (3, 4), "D1\n", "D2\n"),
        ]
    );
}

// `dev-fixtures/sample/` is the trio CONTRIBUTING.md / TESTING.md point at for
// running the dev build. Keep it covering every hunk kind the UI renders
// differently, including a zero-width (delete-vs-modify) conflict.
#[test]
fn dev_fixture_sample_covers_every_hunk_kind() {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../dev-fixtures/sample");
    let read = |name: &str| std::fs::read_to_string(format!("{dir}/{name}")).unwrap();
    let (base, local, remote) = (read("base.ts"), read("local.ts"), read("remote.ts"));
    assert_well_formed(Some(&base), &local, &remote);
    let result = compute_three_way_merge(Some(&base), &local, &remote);
    let has = |kind: HunkKind| result.hunks.iter().any(|h| h.kind == kind);
    for kind in [
        HunkKind::Unchanged,
        HunkKind::Conflict,
        HunkKind::LocalOnly,
        HunkKind::RemoteOnly,
        HunkKind::SameChange,
    ] {
        assert!(has(kind), "missing {kind:?}: {:#?}", result.hunks);
    }
    assert!(
        result
            .hunks
            .iter()
            .any(|h| h.kind == HunkKind::Conflict && h.start_line == h.end_line),
        "missing a zero-width (delete-vs-modify) conflict: {:#?}",
        result.hunks
    );
    // The frontend auto-resolves a `Conflict` hunk on load when both sides
    // agree modulo whitespace (`TAGLINE`, re-indented differently by each
    // side) — keep one in the fixture so `npm run dev:stub` can actually
    // exercise that.
    assert!(
        result.hunks.iter().any(|h| h.kind == HunkKind::Conflict
            && h.local_text.trim() == h.remote_text.trim()
            && h.local_text != h.remote_text),
        "missing a whitespace-only (trim-equal) conflict for the Auto-merge button: {:#?}",
        result.hunks
    );
}
