import { Text } from '@codemirror/state';
import { expect, test } from 'vitest';
import { computePullChange } from './pullChange';

function apply(
    docText: string,
    range: { from: number; to: number },
    side: string,
    coversLines = range.from !== range.to,
) {
    const doc = Text.of(docText.split('\n'));
    const pull = computePullChange(doc, range, side, coversLines);
    if (!pull) return { text: docText, range, coversLines };
    const { from, to, insert } = pull.change;
    const text = docText.slice(0, from) + insert + docText.slice(to);
    return { text, range: pull.range, coversLines: pull.coversLines };
}

test('replaces a mid-document line range, keeping the following line break', () => {
    // "b" is the range [2, 3) — exclusive of its trailing newline.
    const r = apply('a\nb\nc\n', { from: 2, to: 3 }, 'X\nY\n');
    expect(r.text).toBe('a\nX\nY\nc\n');
    expect(r.text.slice(r.range.from, r.range.to)).toBe('X\nY');
});

test('deleting a range (empty side text) removes its line break too', () => {
    const r = apply('a\nb\nc\n', { from: 2, to: 3 }, '');
    expect(r.text).toBe('a\nc\n');
    expect(r.range).toEqual({ from: 2, to: 2 });
});

test('filling a zero-width range inserts whole lines and canonicalizes the range', () => {
    const r = apply('a\nc\n', { from: 2, to: 2 }, 'b\n');
    expect(r.text).toBe('a\nb\nc\n');
    expect(r.text.slice(r.range.from, r.range.to)).toBe('b');
});

test('pulling twice in a row composes (point -> lines -> other lines)', () => {
    const first = apply('a\nc\n', { from: 2, to: 2 }, 'b1\nb2\n');
    const second = apply(first.text, first.range, 'Z\n', first.coversLines);
    expect(second.text).toBe('a\nZ\nc\n');
    const third = apply(second.text, second.range, '', second.coversLines);
    expect(third.text).toBe('a\nc\n');
});

test('range at end of a document without a final newline', () => {
    const r = apply('a\nb', { from: 2, to: 3 }, 'X\n');
    expect(r.text).toBe('a\nX\n');
    const d = apply('a\nb', { from: 2, to: 3 }, '');
    expect(d.text).toBe('a');
});

test('zero-width range at end of a document without a final newline', () => {
    const r = apply('a', { from: 1, to: 1 }, 'b\n');
    expect(r.text).toBe('a\nb');
    expect(r.text.slice(r.range.from, r.range.to)).toBe('b');
});

test('a one-line hunk over an EMPTY line is distinguished from a zero-width hunk', () => {
    // Both are {from: 2, to: 2} in ConflictModel's representation; only the
    // coversLines flag tells them apart.
    expect(apply('a\n\nc', { from: 2, to: 2 }, 'X\n', true).text).toBe(
        'a\nX\nc',
    );
    expect(apply('a\n\nc', { from: 2, to: 2 }, 'X\n', false).text).toBe(
        'a\nX\n\nc',
    );
    // Pulling an empty side into the empty-line hunk deletes that line.
    expect(apply('a\n\nc', { from: 2, to: 2 }, '', true).text).toBe('a\nc');
});

test('returns null for the empty side into a zero-width hunk, and for identical text', () => {
    expect(
        computePullChange(Text.of(['a', '']), { from: 2, to: 2 }, '', false),
    ).toBeNull();
    expect(
        computePullChange(
            Text.of(['a', 'b', '']),
            { from: 2, to: 3 },
            'b\n',
            true,
        ),
    ).toBeNull();
});

test('a range that grew from a point by typing (includes its own line break) is handled', () => {
    // User typed "q\n" into a zero-width hunk at offset 2: range is [2, 4) = "q\n".
    expect(apply('a\nq\nc\n', { from: 2, to: 4 }, 'Z\n', false).text).toBe(
        'a\nZ\nc\n',
    );
});
