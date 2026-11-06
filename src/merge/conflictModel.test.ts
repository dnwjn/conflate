import { ChangeSet, Text } from '@codemirror/state';
import { expect, test } from 'vitest';
import type { Hunk, HunkKind } from '../bindings';
import {
    ConflictModel,
    hunkContentMatchesSource,
    isWhitespaceOnlyConflict,
} from './conflictModel';

/**
 * Builds a full `Hunk` from just the fields a test cares about. The real
 * `Hunk` type (src-tauri/src/diff/types.rs, mirrored in src/bindings.ts) has
 * local/remote line ranges and per-pane text in addition to `start_line`/
 * `end_line`/`kind`; tests only need to control the result-side line range
 * and kind, so the rest is filled with inert defaults.
 *
 * NOTE: `start_line`/`end_line` are 0-based and end-EXCLUSIVE (matching the
 * Rust `Hunk` type), not the inclusive convention used in the task brief's
 * illustrative examples. A single-line hunk over 0-based line `i` is
 * `{ start_line: i, end_line: i + 1 }`; a zero-width hunk (pure deletion,
 * nothing inserted) is `{ start_line: i, end_line: i }`.
 */
function makeHunk(
    partial: Pick<Hunk, 'start_line' | 'end_line' | 'kind'> & Partial<Hunk>,
): Hunk {
    return {
        local_start_line: partial.start_line,
        local_end_line: partial.end_line,
        remote_start_line: partial.start_line,
        remote_end_line: partial.end_line,
        base_text: '',
        local_text: '',
        remote_text: '',
        merged_text: '',
        ...partial,
    };
}

test("rangeFor returns the hunk's initial line range as doc offsets", () => {
    const doc = Text.of(['line1', 'line2', 'line3']);
    // 0-based line 1 ("line2") is the exclusive range [1, 2).
    const model = new ConflictModel(
        [makeHunk({ start_line: 1, end_line: 2, kind: 'Conflict' })],
        doc,
    );
    const range = model.rangeFor(0);
    expect(doc.sliceString(range.from, range.to)).toBe('line2');
});

test('applyEdit shifts ranges after an insertion above the hunk', () => {
    const doc = Text.of(['line1', 'line2', 'line3']);
    // 0-based line 2 ("line3") is the exclusive range [2, 3).
    const model = new ConflictModel(
        [makeHunk({ start_line: 2, end_line: 3, kind: 'Conflict' })],
        doc,
    );
    const before = model.rangeFor(0);
    const changes = ChangeSet.of(
        { from: 0, to: 0, insert: 'inserted\n' },
        doc.length,
    );
    model.applyEdit(changes);
    const after = model.rangeFor(0);
    expect(after.from).toBe(before.from + 'inserted\n'.length);
    expect(after.to).toBe(before.to + 'inserted\n'.length);
});

test("applyEdit does not shift a hunk's range for an edit after it", () => {
    const doc = Text.of(['line1', 'line2', 'line3']);
    const model = new ConflictModel(
        [makeHunk({ start_line: 0, end_line: 1, kind: 'Conflict' })],
        doc,
    );
    const before = model.rangeFor(0);
    // Append text at the very end of the document, well after the hunk.
    const changes = ChangeSet.of(
        { from: doc.length, to: doc.length, insert: '\nmore' },
        doc.length,
    );
    model.applyEdit(changes);
    const after = model.rangeFor(0);
    expect(after).toEqual(before);
});

test("applyEdit grows a hunk's range when text is typed inside it", () => {
    const doc = Text.of(['line1', 'line2', 'line3']);
    const model = new ConflictModel(
        [makeHunk({ start_line: 1, end_line: 2, kind: 'Conflict' })],
        doc,
    );
    const before = model.rangeFor(0);
    // Insert in the middle of "line2".
    const insertAt = before.from + 2;
    const changes = ChangeSet.of(
        { from: insertAt, to: insertAt, insert: 'XX' },
        doc.length,
    );
    model.applyEdit(changes);
    const after = model.rangeFor(0);
    expect(after.from).toBe(before.from);
    expect(after.to).toBe(before.to + 2);
});

test('rangeFor handles a zero-width hunk (pure deletion) without erroring', () => {
    const doc = Text.of(['line1', 'line2', 'line3']);
    // start_line === end_line: no lines at all, e.g. local deleted a line
    // remote didn't touch, and nothing replaced it.
    const model = new ConflictModel(
        [makeHunk({ start_line: 1, end_line: 1, kind: 'Conflict' })],
        doc,
    );
    const range = model.rangeFor(0);
    expect(range.from).toBe(range.to);
    expect(range.from).toBe(doc.line(2).from);
    expect(doc.sliceString(range.from, range.to)).toBe('');
});

test("applyEdit lets typing at a zero-width hunk's position fill it in", () => {
    const doc = Text.of(['line1', 'line2', 'line3']);
    const model = new ConflictModel(
        [makeHunk({ start_line: 1, end_line: 1, kind: 'Conflict' })],
        doc,
    );
    const before = model.rangeFor(0);
    expect(before.from).toBe(before.to);
    const changes = ChangeSet.of(
        { from: before.from, to: before.from, insert: 'filled in' },
        doc.length,
    );
    model.applyEdit(changes);
    const after = model.rangeFor(0);
    expect(after.from).toBe(before.from);
    expect(after.to).toBe(before.from + 'filled in'.length);
});

test('rangeFor handles a zero-width hunk at the end of the document', () => {
    const doc = Text.of(['line1', 'line2']);
    const model = new ConflictModel(
        [makeHunk({ start_line: 2, end_line: 2, kind: 'Conflict' })],
        doc,
    );
    const range = model.rangeFor(0);
    expect(range.from).toBe(range.to);
    expect(range.from).toBe(doc.length);
});

test("applyEdit keeps two adjacent hunks' ranges disjoint after an insertion at their shared boundary", () => {
    const doc = Text.of(['line1', 'line2', 'line3']);
    // Hunk A is a zero-width (pure-deletion) hunk anchored at 0-based line 1
    // -> doc.line(2).from. Hunk B starts at the same 0-based line (1) and
    // covers "line2" -> its `from` is also doc.line(2).from. A's end_line
    // (1) and B's start_line (1) therefore map to the exact same document
    // offset: A's end touches B's start with no gap, the "back-to-back
    // conflicts" case from the review finding. (Two ordinary, non-zero-width
    // hunks can never share a literal offset this way under this line-based
    // conversion — there's always a newline between one hunk's `to` and the
    // next hunk's `from` — so a zero-width hunk is the realistic way two
    // hunks end up touching at a single point.)
    const model = new ConflictModel(
        [
            makeHunk({ start_line: 1, end_line: 1, kind: 'Conflict' }),
            makeHunk({ start_line: 1, end_line: 2, kind: 'Conflict' }),
        ],
        doc,
    );
    const boundary = model.rangeFor(0);
    expect(boundary.from).toBe(boundary.to);
    expect(boundary.from).toBe(model.rangeFor(1).from);

    // Type exactly at the shared boundary.
    const changes = ChangeSet.of(
        { from: boundary.from, to: boundary.from, insert: 'NEW' },
        doc.length,
    );
    model.applyEdit(changes);

    const afterA = model.rangeFor(0);
    const afterB = model.rangeFor(1);

    // Each range must still be internally consistent (from <= to).
    expect(afterA.from).toBeLessThanOrEqual(afterA.to);
    expect(afterB.from).toBeLessThanOrEqual(afterB.to);

    // The two ranges must be disjoint: they may touch at a single point
    // (one's `to` equal to the other's `from`), but must not overlap.
    const disjointOrTouching =
        afterA.to <= afterB.from || afterB.to <= afterA.from;
    expect(disjointOrTouching).toBe(true);

    // The earlier hunk (A) absorbs the typed text; the later hunk (B)
    // shifts forward past it without re-absorbing it.
    expect(afterA.from).toBe(boundary.from);
    expect(afterA.to).toBe(boundary.from + 'NEW'.length);
    expect(afterB.from).toBe(afterA.to);
});

test('markResolved reduces unresolvedCount', () => {
    const doc = Text.of(['a', 'b']);
    const model = new ConflictModel(
        [
            makeHunk({
                start_line: 0,
                end_line: 1,
                kind: 'Conflict',
                local_text: 'L\n',
                remote_text: 'R\n',
            }),
            makeHunk({
                start_line: 1,
                end_line: 2,
                kind: 'Conflict',
                local_text: 'L\n',
                remote_text: 'R\n',
            }),
        ],
        doc,
    );
    expect(model.unresolvedCount()).toBe(2);
    model.markResolved(0);
    expect(model.isResolved(0)).toBe(true);
    expect(model.isResolved(1)).toBe(false);
    expect(model.unresolvedCount()).toBe(1);
});

test('auto-mergeable hunk kinds start resolved and do not count toward unresolvedCount', () => {
    const doc = Text.of(['a']);
    const kinds: HunkKind[] = [
        'Unchanged',
        'LocalOnly',
        'RemoteOnly',
        'SameChange',
    ];
    for (const kind of kinds) {
        const model = new ConflictModel(
            [makeHunk({ start_line: 0, end_line: 1, kind })],
            doc,
        );
        expect(model.isResolved(0)).toBe(true);
        expect(model.unresolvedCount()).toBe(0);
    }
});

test('Conflict hunks start unresolved among a mix of auto-mergeable hunks', () => {
    const doc = Text.of(['a', 'b', 'c']);
    const model = new ConflictModel(
        [
            makeHunk({ start_line: 0, end_line: 1, kind: 'Unchanged' }),
            makeHunk({
                start_line: 1,
                end_line: 2,
                kind: 'Conflict',
                local_text: 'L\n',
                remote_text: 'R\n',
            }),
            makeHunk({ start_line: 2, end_line: 3, kind: 'LocalOnly' }),
        ],
        doc,
    );
    expect(model.isResolved(0)).toBe(true);
    expect(model.isResolved(1)).toBe(false);
    expect(model.isResolved(2)).toBe(true);
    expect(model.unresolvedCount()).toBe(1);
});

test('a Conflict hunk where local and remote agree modulo whitespace starts unresolved, same as a genuine conflict', () => {
    const doc = Text.of(['a', 'b']);
    const model = new ConflictModel(
        [
            makeHunk({
                start_line: 0,
                end_line: 1,
                kind: 'Conflict',
                local_text: 'two \n',
                remote_text: ' two\n',
            }),
            makeHunk({
                start_line: 1,
                end_line: 2,
                kind: 'Conflict',
                local_text: 'L\n',
                remote_text: 'R\n',
            }),
        ],
        doc,
    );
    expect(model.isResolved(0)).toBe(false);
    expect(model.wasAutoMerged(0)).toBe(false);
    expect(model.isResolved(1)).toBe(false);
    expect(model.wasAutoMerged(1)).toBe(false);
    expect(model.unresolvedCount()).toBe(2);
});

test('isWhitespaceOnlyConflict is true only for a Conflict hunk whose sides agree modulo whitespace', () => {
    const whitespaceOnly = makeHunk({
        start_line: 0,
        end_line: 1,
        kind: 'Conflict',
        local_text: 'two \n',
        remote_text: ' two\n',
    });
    const genuine = makeHunk({
        start_line: 0,
        end_line: 1,
        kind: 'Conflict',
        local_text: 'L\n',
        remote_text: 'R\n',
    });
    const nonConflictKind = makeHunk({
        start_line: 0,
        end_line: 1,
        kind: 'LocalOnly',
        local_text: 'two \n',
        remote_text: ' two\n',
    });
    expect(isWhitespaceOnlyConflict(whitespaceOnly)).toBe(true);
    expect(isWhitespaceOnlyConflict(genuine)).toBe(false);
    expect(isWhitespaceOnlyConflict(nonConflictKind)).toBe(false);
});

test('wasAutoMerged stays true for an auto-mergeable kind even after the user later pulls/unpulls a side', () => {
    const doc = Text.of(['a']);
    const model = new ConflictModel(
        [makeHunk({ start_line: 0, end_line: 1, kind: 'LocalOnly' })],
        doc,
    );
    model.markUnresolved(0);
    expect(model.wasAutoMerged(0)).toBe(true);
    model.markResolved(0);
    expect(model.wasAutoMerged(0)).toBe(true);
});

test('hunkCount, setRange and markUnresolved', () => {
    const doc = Text.of(['line1', 'line2', 'line3']);
    const model = new ConflictModel(
        [
            makeHunk({ start_line: 0, end_line: 1, kind: 'Unchanged' }),
            makeHunk({
                start_line: 1,
                end_line: 2,
                kind: 'Conflict',
                local_text: 'L\n',
                remote_text: 'R\n',
            }),
        ],
        doc,
    );
    expect(model.hunkCount()).toBe(2);
    model.setRange(1, { from: 2, to: 4 });
    expect(model.rangeFor(1)).toEqual({ from: 2, to: 4 });
    model.markResolved(1);
    expect(model.unresolvedCount()).toBe(0);
    model.markUnresolved(1);
    expect(model.isResolved(1)).toBe(false);
    expect(model.unresolvedCount()).toBe(1);
});

test('hunkContentMatchesSource', () => {
    const hunk = makeHunk({
        start_line: 0,
        end_line: 1,
        kind: 'Conflict',
        local_text: 'local two\n',
        remote_text: 'remote two\n',
    });

    // matches local
    const localDoc = Text.of(['local two']);
    expect(
        hunkContentMatchesSource(
            localDoc,
            { from: 0, to: localDoc.length },
            hunk,
        ),
    ).toBe(true);

    // matches remote
    const remoteDoc = Text.of(['remote two']);
    expect(
        hunkContentMatchesSource(
            remoteDoc,
            { from: 0, to: remoteDoc.length },
            hunk,
        ),
    ).toBe(true);

    // matches stacked local+remote (accept-both)
    const stackedDoc = Text.of(['local two', 'remote two']);
    expect(
        hunkContentMatchesSource(
            stackedDoc,
            { from: 0, to: stackedDoc.length },
            hunk,
        ),
    ).toBe(true);

    // whitespace-only difference still matches (trimmed comparison)
    const trailingSpaceDoc = Text.of(['local two ']);
    expect(
        hunkContentMatchesSource(
            trailingSpaceDoc,
            { from: 0, to: trailingSpaceDoc.length },
            hunk,
        ),
    ).toBe(true);

    // genuinely different content does not match
    const editedDoc = Text.of(['something else']);
    expect(
        hunkContentMatchesSource(
            editedDoc,
            { from: 0, to: editedDoc.length },
            hunk,
        ),
    ).toBe(false);
});
