import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { expect, test } from 'vitest';
import { resultSpan, ribbonPath, sideSpan } from './hunkConnectors';

function makeView(text: string): EditorView {
    const container = document.createElement('div');
    document.body.appendChild(container);
    return new EditorView({
        parent: container,
        state: EditorState.create({ doc: text }),
    });
}

test('ribbonPath draws a quadrilateral between the two spans', () => {
    const d = ribbonPath(100, { top: 0, bottom: 10 }, { top: 20, bottom: 30 });
    expect(d.startsWith('M 0 0')).toBe(true);
    expect(d).toContain('100 20');
    expect(d).toContain('L 100 30');
    expect(d.endsWith('Z')).toBe(true);
});

test('ribbonPath degenerates to a thin sliver for a zero-height (gap) span', () => {
    const d = ribbonPath(50, { top: 5, bottom: 5 }, { top: 5, bottom: 5 });
    expect(d).toContain('M 0 5');
    expect(d).toContain('50 5');
});

test('sideSpan covers a non-zero-width line range (top at or before bottom)', () => {
    const view = makeView('one\ntwo\nthree\nfour\n');
    const span = sideSpan(view, 1, 3); // lines "two", "three" (0-based, end-exclusive)
    expect(span.top).toBeLessThanOrEqual(span.bottom);
    view.destroy();
});

test('sideSpan collapses a zero-width (pure-deletion) range to a single point', () => {
    const view = makeView('one\ntwo\nthree\n');
    const span = sideSpan(view, 1, 1);
    expect(span.top).toBe(span.bottom);
    view.destroy();
});

test('resultSpan covering=true spans from the first to the last line of the range', () => {
    const view = makeView('one\ntwo\nthree\n');
    const doc = view.state.doc;
    const range = { from: doc.line(1).from, to: doc.line(2).to };
    const span = resultSpan(view, range, true);
    expect(span.top).toBeLessThanOrEqual(span.bottom);
    view.destroy();
});

test('resultSpan covering=false collapses the gap to a single point', () => {
    const view = makeView('one\ntwo\nthree\n');
    const doc = view.state.doc;
    const pos = doc.line(2).from;
    const span = resultSpan(view, { from: pos, to: pos }, false);
    expect(span.top).toBe(span.bottom);
    view.destroy();
});
