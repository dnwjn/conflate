import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { expect, test } from 'vitest';
import { ConflictModel } from './conflictModel';
import {
    computeConnectorGeometry,
    resultSpan,
    ribbonPath,
    sideSpan,
} from './hunkConnectors';
import { makeHunk } from './testHunks';

function makeView(text: string): EditorView {
    const container = document.createElement('div');
    document.body.appendChild(container);
    return new EditorView({
        parent: container,
        state: EditorState.create({ doc: text }),
    });
}

test('ribbonPath draws a quadrilateral between the two spans, inset by half the stroke width', () => {
    // `.tw-connector` strokes at 1px, centered on the path (styles.css), so
    // the path itself is drawn 0.5px inside each true span edge — otherwise
    // the stroke's OUTER edge (what's actually visible) would overshoot the
    // real boundary by 0.5px on both the top and the bottom.
    const d = ribbonPath(100, { top: 0, bottom: 10 }, { top: 20, bottom: 30 });
    expect(d.startsWith('M 0 0.5')).toBe(true);
    expect(d).toContain('100 20.5');
    expect(d).toContain('L 100 29.5');
    expect(d).toContain('0 9.5');
    expect(d.endsWith('Z')).toBe(true);
});

test('ribbonPath insets by half of a given (non-default) stroke width', () => {
    // `.tw-connector-gap` strokes at 2px (styles.css) to match the pane's
    // thicker gap line, so it needs double the inset a 1px stroke does.
    const d = ribbonPath(
        100,
        { top: 0, bottom: 10 },
        { top: 20, bottom: 30 },
        2,
    );
    expect(d.startsWith('M 0 1')).toBe(true);
    expect(d).toContain('100 21');
    expect(d).toContain('L 100 29');
    expect(d).toContain('0 9');
});

test('ribbonPath degenerates to a thin sliver for a zero-height (gap) span, with no inset', () => {
    // Insetting a zero-height span would invert it (bottom < top), so the
    // stroke inset is skipped whenever top === bottom.
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

test('computeConnectorGeometry marks hasGap for a hunk with a zero-width side, not for one with real spans on every side', () => {
    // Hunk 0 (SameChange): a real 1-line span on every side — no gap.
    // Hunk 1 (LocalOnly): local has the line, remote has nothing (a pure
    // deletion from remote's perspective) — a zero-width side, hence a gap.
    const localView = makeView('same\nlocal-only\n');
    const resultView = makeView('same\nlocal-only\n');
    const remoteView = makeView('same\n');
    const hunks = [
        makeHunk({
            start_line: 0,
            end_line: 1,
            kind: 'SameChange',
            local_text: 'same\n',
            remote_text: 'same\n',
        }),
        makeHunk({
            start_line: 1,
            end_line: 2,
            kind: 'LocalOnly',
            local_start_line: 1,
            local_end_line: 2,
            remote_start_line: 1,
            remote_end_line: 1,
            local_text: 'local-only\n',
            remote_text: '',
        }),
    ];
    const conflictModel = new ConflictModel(hunks, resultView.state.doc);
    const geometry = computeConnectorGeometry(
        hunks,
        conflictModel,
        () => true,
        localView,
        resultView,
        remoteView,
    );
    expect(geometry[0].localHasGap).toBe(false);
    expect(geometry[0].remoteHasGap).toBe(false);
    // Hunk 1 (LocalOnly): local's own span is real, so its divider
    // (LOCAL<->RESULT) has no gap; remote's span is the zero-width side.
    expect(geometry[1].localHasGap).toBe(false);
    expect(geometry[1].remoteHasGap).toBe(true);
    localView.destroy();
    resultView.destroy();
    remoteView.destroy();
});
