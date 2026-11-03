import { Text } from '@codemirror/state';
import { expect, test } from 'vitest';
import { ConflictModel } from './conflictModel';
import { hunkIndexAt, nextConflict, prevConflict } from './hunkNav';
import { makeHunk } from './testHunks';

function threeHunkModel(): ConflictModel {
    const doc = Text.of(['a', 'b', 'c', 'd']);
    return new ConflictModel(
        [
            makeHunk({ start_line: 0, end_line: 0, kind: 'LocalOnly' }),
            makeHunk({ start_line: 1, end_line: 1, kind: 'Conflict' }),
            makeHunk({ start_line: 2, end_line: 2, kind: 'Conflict' }),
        ],
        doc,
    );
}

test('nextConflict returns the index of the next unresolved Conflict hunk', () => {
    const model = threeHunkModel();
    expect(nextConflict(model, -1)).toBe(1);
    model.markResolved(1);
    expect(nextConflict(model, 1)).toBe(2);
});

test('nextConflict skips resolved conflicts and wraps around to the start', () => {
    const model = threeHunkModel();
    expect(nextConflict(model, 2)).toBe(1);
    model.markResolved(1);
    expect(nextConflict(model, 2)).toBe(2);
});

test('nextConflict returns -1 when nothing is unresolved', () => {
    const model = threeHunkModel();
    model.markResolved(1);
    model.markResolved(2);
    expect(nextConflict(model, -1)).toBe(-1);
    expect(prevConflict(model, 3)).toBe(-1);
});

test('prevConflict returns the previous unresolved Conflict hunk, wrapping to the end', () => {
    const model = threeHunkModel();
    expect(prevConflict(model, 3)).toBe(2);
    expect(prevConflict(model, 2)).toBe(1);
    expect(prevConflict(model, 1)).toBe(2);
    model.markResolved(2);
    expect(prevConflict(model, 1)).toBe(1);
});

// Delete-vs-modify (pinned on the Rust side by
// `delete_vs_modify_fixture_has_zero_width_conflict_then_unchanged_at_same_line`):
// result "a\nc\nD1\n"; the zero-width Conflict (index 1) and the following
// Unchanged hunk (index 2) both start at offset 2.
function zeroWidthConflictModel() {
    const hunks = [
        makeHunk({ start_line: 0, end_line: 1, kind: 'Unchanged' }),
        makeHunk({ start_line: 1, end_line: 1, kind: 'Conflict' }),
        makeHunk({ start_line: 1, end_line: 2, kind: 'Unchanged' }),
        makeHunk({ start_line: 2, end_line: 3, kind: 'Conflict' }),
    ];
    return {
        hunks,
        model: new ConflictModel(hunks, Text.of(['a', 'c', 'D1', ''])),
    };
}

test('hunkIndexAt prefers a zero-width conflict over a wider hunk starting at the same offset', () => {
    const { hunks, model } = zeroWidthConflictModel();
    expect(model.rangeFor(1)).toEqual({ from: 2, to: 2 });
    expect(model.rangeFor(2)).toEqual({ from: 2, to: 3 });
    expect(hunkIndexAt(model, hunks, 2)).toBe(1);
    // Elsewhere it is still "the hunk containing pos".
    expect(hunkIndexAt(model, hunks, 0)).toBe(0);
    expect(hunkIndexAt(model, hunks, 1)).toBe(0);
    expect(hunkIndexAt(model, hunks, 3)).toBe(2);
    expect(hunkIndexAt(model, hunks, 4)).toBe(3);
    expect(hunkIndexAt(model, hunks, 6)).toBe(3);
});

test('hunkIndexAt still prefers the zero-width conflict once resolved (it stays the hunk at that point)', () => {
    const { hunks, model } = zeroWidthConflictModel();
    model.markResolved(1);
    expect(hunkIndexAt(model, hunks, 2)).toBe(1);
});

test('hunkIndexAt prefers an UNRESOLVED conflict when several conflicts share the offset', () => {
    const hunks = [
        makeHunk({ start_line: 0, end_line: 0, kind: 'Conflict' }),
        makeHunk({ start_line: 0, end_line: 0, kind: 'Conflict' }),
        makeHunk({ start_line: 0, end_line: 1, kind: 'Unchanged' }),
    ];
    const model = new ConflictModel(hunks, Text.of(['x', '']));
    expect(hunkIndexAt(model, hunks, 0)).toBe(1);
    model.markResolved(1);
    expect(hunkIndexAt(model, hunks, 0)).toBe(0);
    model.markResolved(0);
    expect(hunkIndexAt(model, hunks, 0)).toBe(1);
});

test('hunkIndexAt returns -1 for an empty hunk list', () => {
    const model = new ConflictModel([], Text.of(['']));
    expect(hunkIndexAt(model, [], 0)).toBe(-1);
});
