import { expect, test } from 'vitest';
import type { WordDiffOp } from '../bindings';
import { wordDiffRanges } from './wordDiff';

test('maps Delete ops to old-side ranges and Insert ops to new-side ranges', () => {
    const ops: WordDiffOp[] = [
        { kind: 'Equal', text: 'let ' },
        { kind: 'Delete', text: 'foo' },
        { kind: 'Insert', text: 'barbaz' },
        { kind: 'Equal', text: ' = 1;' },
    ];
    const ranges = wordDiffRanges(ops, 10, 100);
    expect(ranges.old).toEqual([{ from: 14, to: 17 }]);
    expect(ranges.new).toEqual([{ from: 104, to: 110 }]);
});

test('whitespace-only ops are not highlighted but still advance offsets', () => {
    const ops: WordDiffOp[] = [
        { kind: 'Equal', text: 'let' },
        { kind: 'Delete', text: ' ' },
        { kind: 'Insert', text: '  ' },
        { kind: 'Equal', text: 'x = ' },
        { kind: 'Delete', text: '1' },
        { kind: 'Insert', text: '2' },
        { kind: 'Equal', text: ';' },
    ];
    const ranges = wordDiffRanges(ops, 0, 0);
    // "let x = 1;" -> "1" at 8; "let  x = 2;" -> "2" at 9.
    expect(ranges.old).toEqual([{ from: 8, to: 9 }]);
    expect(ranges.new).toEqual([{ from: 9, to: 10 }]);
});

test('ops mixing words and whitespace are still highlighted', () => {
    const ops: WordDiffOp[] = [
        { kind: 'Delete', text: 'foo ' },
        { kind: 'Equal', text: 'x' },
    ];
    expect(wordDiffRanges(ops, 0, 0).old).toEqual([{ from: 0, to: 4 }]);
});
