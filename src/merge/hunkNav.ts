import type { Hunk } from '../bindings';
import type { ConflictModel } from './conflictModel';

/**
 * Conflict navigation over a `ConflictModel`.
 *
 * Only UNRESOLVED hunks are navigation targets. Non-`Conflict` hunks start
 * resolved in the model (they were auto-merged) and never become unresolved
 * except by undoing a resolution, so "unresolved" is exactly "conflict
 * still needing attention".
 *
 * Both functions wrap around (like an editor's "find next"), and return -1
 * when there is no unresolved hunk at all. `currentIndex` may be -1 (before
 * the first hunk) or `hunkCount()` (after the last).
 */
export function nextConflict(
    model: ConflictModel,
    currentIndex: number,
): number {
    const count = model.hunkCount();
    if (count === 0) return -1;
    for (let step = 1; step <= count; step++) {
        const index = mod(currentIndex + step, count);
        if (!model.isResolved(index)) return index;
    }
    return -1;
}

export function prevConflict(
    model: ConflictModel,
    currentIndex: number,
): number {
    const count = model.hunkCount();
    if (count === 0) return -1;
    for (let step = 1; step <= count; step++) {
        const index = mod(currentIndex - step, count);
        if (!model.isResolved(index)) return index;
    }
    return -1;
}

/**
 * Index of the hunk the result cursor at offset `pos` "is on", for keyboard
 * actions (accept local/remote/both, previous/next conflict) and the
 * "Conflict N of M" counter. -1 if there are no hunks.
 *
 * Hunks tile the result document, so this is normally just the last hunk
 * whose range starts at or before `pos`. The exception is a ZERO-WIDTH hunk
 * (e.g. delete-vs-modify: one side deleted the lines, so the conflict covers
 * no result lines): it shares its offset with the hunk that follows it, and
 * "last one starting here" would always pick that following (usually
 * Unchanged) hunk — making the conflict unreachable from the keyboard. So,
 * among the hunks whose range contains `pos`, an unresolved Conflict wins,
 * then any Conflict, then the last-starting hunk; ties keep the later index.
 *
 * Scroll sync deliberately does NOT use this (it wants the hunk whose lines
 * are actually shown at that offset; see `threeWayView.ts`).
 */
export function hunkIndexAt(
    model: ConflictModel,
    hunks: readonly Hunk[],
    pos: number,
): number {
    let found = -1;
    for (let i = 0; i < hunks.length; i++) {
        if (model.rangeFor(i).from <= pos) found = i;
        else break;
    }
    if (found < 0) return -1;
    const rank = (i: number) =>
        hunks[i].kind !== 'Conflict' ? 0 : model.isResolved(i) ? 1 : 2;
    let best = found;
    for (let i = found - 1; i >= 0; i--) {
        // Ranges are ordered, so once one ends before `pos`, all earlier ones do.
        if (model.rangeFor(i).to < pos) break;
        if (rank(i) > rank(best)) best = i;
    }
    return best;
}

function mod(n: number, m: number): number {
    return ((n % m) + m) % m;
}
