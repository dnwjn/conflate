import type { ChangeSet, Text } from '@codemirror/state';
import type { Hunk, HunkKind } from '../bindings';

/**
 * Hunk kinds the 3-way merge already resolved automatically. Everything else
 * (`Conflict`) needs the user's attention and starts unresolved — except a
 * `Conflict` where local and remote agree modulo whitespace, which is also
 * auto-resolved (see `isAutoMergeable`).
 */
const AUTO_MERGEABLE_KINDS: ReadonlySet<HunkKind> = new Set([
    'Unchanged',
    'LocalOnly',
    'RemoteOnly',
    'SameChange',
]);

/**
 * Whether a hunk is resolved by the 3-way merge/load-time pass without the
 * user picking a side: every `AUTO_MERGEABLE_KINDS` kind, plus a `Conflict`
 * where both sides differ only in whitespace (a genuine disagreement is left
 * for the user). `merged_text` already holds local's version for such a
 * hunk (see `three_way.rs`'s "ours first" seeding), which is fine since local
 * and remote only differ in whitespace there.
 */
function isAutoMergeable(hunk: Hunk): boolean {
    return (
        AUTO_MERGEABLE_KINDS.has(hunk.kind) ||
        (hunk.kind === 'Conflict' &&
            hunk.local_text.trim() === hunk.remote_text.trim())
    );
}

/**
 * Whether a hunk's current (live) text in the result document still matches
 * one of its known source texts — local's, remote's, or both stacked
 * together (the "accept both" case) — modulo whitespace (consistent with
 * `isAutoMergeable`'s own whitespace-insensitive comparison). `false` means
 * the hunk was hand-edited/pasted into since being pulled/auto-merged, so its
 * content no longer represents a choice the merge/user explicitly made.
 *
 * Only meaningful for a hunk that is currently shown as resolved/auto-merged
 * (green) — an unresolved conflict's content is expected to diverge from
 * both sides until the user picks one, so this is not consulted there.
 */
export function hunkContentMatchesSource(
    doc: Text,
    range: { from: number; to: number },
    hunk: Hunk,
): boolean {
    const text = doc.sliceString(range.from, range.to).trim();
    const candidates = [
        hunk.local_text.trim(),
        hunk.remote_text.trim(),
        (hunk.local_text + hunk.remote_text).trim(),
    ];
    return candidates.includes(text);
}

interface TrackedRange {
    from: number;
    to: number;
}

/**
 * Converts a hunk's 0-based, end-exclusive line range (`start_line`/`end_line`,
 * as produced by the Rust 3-way merge — see `src-tauri/src/diff/types.rs`)
 * into CM6 document offsets.
 *
 * `doc.line(n)` is 1-indexed, so the hunk's lines `start_line..end_line`
 * (0-based) are CM6 lines `start_line + 1` through `end_line` inclusive.
 *
 * A zero-width hunk (`start_line === end_line`) covers no lines at all —
 * e.g. a pure deletion where local/remote removed lines without replacing
 * them. It maps to an empty range at the position immediately before line
 * `start_line` (0-based), i.e. the start of CM6 line `start_line + 1`, or
 * the end of the document if `start_line` is at or past the end.
 */
function lineRangeToOffsets(
    doc: Text,
    startLine: number,
    endLine: number,
): TrackedRange {
    if (startLine === endLine) {
        const pos =
            startLine < doc.lines ? doc.line(startLine + 1).from : doc.length;
        return { from: pos, to: pos };
    }
    const from = doc.line(startLine + 1).from;
    const to = doc.line(endLine).to;
    return { from, to };
}

/**
 * Tracks the live CM6 document ranges corresponding to a 3-way merge's
 * hunks, keeping them correctly positioned as the user edits the result
 * document, and tracks which hunks have been resolved by the user.
 *
 * Auto-mergeable hunks (see `isAutoMergeable`) start resolved, since the
 * 3-way merge already decided their content; only a genuine `Conflict`
 * needs explicit user resolution.
 */
export class ConflictModel {
    private ranges: TrackedRange[];
    private resolved: boolean[];
    /**
     * Whether each hunk was resolved at construction time (by the 3-way
     * merge/load-time pass) rather than by the user later pulling a side.
     * Unlike `resolved`, this never changes after construction — it's used
     * to tell an "auto-merged" pill apart from a user-"resolved" one even
     * after the user pulls/undoes a side for the same hunk.
     */
    private autoMerged: boolean[];

    constructor(hunks: Hunk[], doc: Text) {
        this.ranges = hunks.map((hunk) =>
            lineRangeToOffsets(doc, hunk.start_line, hunk.end_line),
        );
        this.autoMerged = hunks.map(isAutoMergeable);
        this.resolved = [...this.autoMerged];
    }

    rangeFor(hunkIndex: number): { from: number; to: number } {
        const range = this.ranges[hunkIndex];
        return { from: range.from, to: range.to };
    }

    /** Number of hunks tracked (every hunk, not just conflicts). */
    hunkCount(): number {
        return this.ranges.length;
    }

    /**
     * Overwrites a hunk's tracked range. Used by the 3-pane view after a
     * "pull hunk" transaction to put the range back into this class's
     * canonical form (`to` at the END of the last line, excluding its line
     * break; zero-width ranges at a line start), and by undo/redo to restore
     * a range snapshot that plain position mapping cannot reconstruct.
     */
    setRange(hunkIndex: number, range: { from: number; to: number }): void {
        this.ranges[hunkIndex] = { from: range.from, to: range.to };
    }

    markResolved(hunkIndex: number): void {
        this.resolved[hunkIndex] = true;
    }

    /** Reverts `markResolved` (used when the user undoes a pull). */
    markUnresolved(hunkIndex: number): void {
        this.resolved[hunkIndex] = false;
    }

    isResolved(hunkIndex: number): boolean {
        return this.resolved[hunkIndex];
    }

    /** Whether this hunk was auto-resolved at load rather than by the user. */
    wasAutoMerged(hunkIndex: number): boolean {
        return this.autoMerged[hunkIndex];
    }

    /**
     * Re-maps every tracked range through a CM6 `ChangeSet` so ranges stay
     * correctly positioned after a live document edit.
     *
     * `to` is always mapped with assoc +1, so a hunk absorbs text typed
     * exactly at its own right edge (including filling in a zero-width,
     * pure-deletion hunk's point — the hunk's `from` and `to` are equal
     * there, so this is also what grows it).
     *
     * `from` is mapped with assoc -1 ("absorb text typed here") UNLESS this
     * range's `from` currently sits exactly where another tracked range's
     * `to` sits — i.e. this hunk is immediately preceded by another hunk
     * with no gap between them. In that case `from` is mapped with assoc
     * +1 instead, so it shifts forward with the inserted text rather than
     * absorbing it.
     *
     * Without this, an insertion typed exactly at a boundary shared by two
     * adjacent hunks would be absorbed by BOTH: the earlier hunk's `to`
     * (assoc +1) grows forward over it, and the later hunk's `from` (assoc
     * -1) would also stay anchored there and grow backward over the same
     * text, producing overlapping ranges. Giving the earlier hunk exclusive
     * claim to a shared boundary — "earlier hunk wins" — keeps the two
     * ranges disjoint (they may still touch at a single point, which is not
     * an overlap under the half-open-interval convention used throughout
     * this class). An isolated hunk's own boundary (nothing else ends
     * exactly where it starts) is unaffected and keeps absorbing text typed
     * at its own edge, including its own zero-width deletion point.
     */
    applyEdit(changes: ChangeSet): void {
        const previous = this.ranges;
        this.ranges = previous.map((range, index) => {
            const sharesBoundaryWithEarlierHunk = previous.some(
                (other, otherIndex) =>
                    otherIndex !== index && other.to === range.from,
            );
            const fromAssoc = sharesBoundaryWithEarlierHunk ? 1 : -1;
            return {
                from: changes.mapPos(range.from, fromAssoc),
                to: changes.mapPos(range.to, 1),
            };
        });
    }

    unresolvedCount(): number {
        return this.resolved.filter((isResolved) => !isResolved).length;
    }
}
