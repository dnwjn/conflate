import { redo, undo } from '@codemirror/commands';
import { afterEach, expect, test, vi } from 'vitest';
import type {
    MergeInputPayload,
    ThreeWayMergeResult,
    WordDiffOp,
} from '../bindings';
import { makeHunk } from './testHunks';
import {
    createThreeWayView,
    type FrameScheduler,
    pullHunk,
    type ThreeWayView,
} from './threeWayView';

// base:   one / two / three / four
// local:  one / local two / three / four local
// remote: one / remote two / three / four
const input: MergeInputPayload = {
    base: 'one\ntwo\nthree\nfour\n',
    local: 'one\nlocal two\nthree\nfour local\n',
    remote: 'one\nremote two\nthree\nfour\n',
    languageHint: null,
    fileName: 'four.txt',
};

const mergeResult: ThreeWayMergeResult = {
    auto_merged_text: 'one\nlocal two\nthree\nfour local\n',
    conflict_count: 1,
    hunks: [
        makeHunk({
            start_line: 0,
            end_line: 1,
            kind: 'Unchanged',
            local_text: 'one\n',
            remote_text: 'one\n',
        }),
        makeHunk({
            start_line: 1,
            end_line: 2,
            kind: 'Conflict',
            base_text: 'two\n',
            local_text: 'local two\n',
            remote_text: 'remote two\n',
            merged_text: 'local two\n',
        }),
        makeHunk({
            start_line: 2,
            end_line: 3,
            kind: 'Unchanged',
            local_text: 'three\n',
            remote_text: 'three\n',
        }),
        makeHunk({
            start_line: 3,
            end_line: 4,
            kind: 'LocalOnly',
            local_text: 'four local\n',
            remote_text: 'four\n',
            merged_text: 'four local\n',
        }),
    ],
};

/** Scheduler that never fires on its own; lets tests count/flush frames. */
function manualScheduler() {
    let next = 1;
    const pending = new Map<number, () => void>();
    const scheduler: FrameScheduler & { requests: number; cancels: number } = {
        requests: 0,
        cancels: 0,
        request(cb) {
            this.requests++;
            const id = next++;
            pending.set(id, cb);
            return id;
        },
        cancel(id) {
            this.cancels++;
            pending.delete(id);
        },
    };
    return { scheduler, pending };
}

const created: ThreeWayView[] = [];
afterEach(() => {
    for (const v of created.splice(0)) v.destroy();
    document.body.innerHTML = '';
});

function setup(options: Parameters<typeof createThreeWayView>[3] = {}) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const { scheduler, pending } = manualScheduler();
    const view = createThreeWayView(container, input, mergeResult, {
        scheduler,
        ...options,
    });
    created.push(view);
    return { view, scheduler, pending, container };
}

/** Result-doc line numbers (1-based) that differ from the side, per the live chunks. */
function changedResultLines(
    v: ThreeWayView,
    side: 'local' | 'remote',
): number[] {
    const doc = v.resultView.state.doc;
    const out: number[] = [];
    for (const chunk of v.liveChunks(side)) {
        if (chunk.fromB === chunk.toB) continue;
        for (
            let n = doc.lineAt(chunk.fromB).number;
            n <= doc.lineAt(chunk.endB).number;
            n++
        )
            out.push(n);
    }
    return out;
}

test('renders three panes with the result seeded from auto_merged_text', () => {
    const { view, container } = setup();
    expect(container.querySelectorAll('.tw-pane')).toHaveLength(3);
    expect(view.resultView.state.doc.toString()).toBe(
        mergeResult.auto_merged_text,
    );
    expect(view.localView.state.readOnly).toBe(true);
    expect(view.remoteView.state.readOnly).toBe(true);
    expect(view.resultView.state.readOnly).toBe(false);
    expect(container.querySelector('.tw-unresolved-pill')?.textContent).toBe(
        '1 unresolved',
    );
});

test("pullHunk replaces the result range with the chosen side's text and marks the hunk resolved", () => {
    const { view } = setup();
    expect(view.conflictModel.isResolved(1)).toBe(false);
    expect(pullHunk(view, 1, 'remote')).toBe(true);
    expect(view.resultView.state.doc.toString()).toBe(
        'one\nremote two\nthree\nfour local\n',
    );
    expect(view.conflictModel.isResolved(1)).toBe(true);
    expect(view.conflictModel.unresolvedCount()).toBe(0);
    const range = view.conflictModel.rangeFor(1);
    expect(view.resultView.state.sliceDoc(range.from, range.to)).toBe(
        'remote two',
    );
    // Switching sides afterwards composes on the updated range.
    expect(pullHunk(view, 1, 'local')).toBe(true);
    expect(view.resultView.state.doc.toString()).toBe(
        mergeResult.auto_merged_text,
    );
});

test('pullHunk composes with prior manual edits via the live ConflictModel range', () => {
    const { view } = setup();
    view.resultView.dispatch({ changes: { from: 0, insert: 'zero\n' } });
    view.resultView.dispatch({
        changes: { from: view.resultView.state.doc.length, insert: 'five\n' },
    });
    pullHunk(view, 1, 'remote');
    pullHunk(view, 3, 'remote');
    expect(view.resultView.state.doc.toString()).toBe(
        'zero\none\nremote two\nthree\nfour\nfive\n',
    );
});

test('undo/redo of a pull restores both the text and the resolution state', () => {
    const { view } = setup();
    pullHunk(view, 1, 'remote');
    expect(undo(view.resultView)).toBe(true);
    expect(view.resultView.state.doc.toString()).toBe(
        mergeResult.auto_merged_text,
    );
    expect(view.conflictModel.isResolved(1)).toBe(false);
    expect(view.conflictModel.rangeFor(1)).toEqual({ from: 4, to: 13 });
    expect(redo(view.resultView)).toBe(true);
    expect(view.resultView.state.doc.toString()).toBe(
        'one\nremote two\nthree\nfour local\n',
    );
    expect(view.conflictModel.isResolved(1)).toBe(true);
});

test('pulling a side whose text already matches resolves without editing', () => {
    const { view } = setup();
    const before = view.resultView.state.doc.toString();
    expect(pullHunk(view, 1, 'local')).toBe(true);
    expect(view.resultView.state.doc.toString()).toBe(before);
    expect(view.conflictModel.isResolved(1)).toBe(true);
    // Nothing left to do for it now.
    expect(pullHunk(view, 1, 'local')).toBe(false);
});

test("pullBoth inserts local's lines followed by remote's and marks the hunk resolved", () => {
    const { view } = setup();
    expect(view.pullBoth(1)).toBe(true);
    expect(view.resultView.state.doc.toString()).toBe(
        'one\nlocal two\nremote two\nthree\nfour local\n',
    );
    expect(view.conflictModel.isResolved(1)).toBe(true);
    const range = view.conflictModel.rangeFor(1);
    expect(view.resultView.state.sliceDoc(range.from, range.to)).toBe(
        'local two\nremote two',
    );
});

test('whitespace-only conflicts are auto-resolved on load, genuine ones are not', () => {
    const trivialInput: MergeInputPayload = {
        base: 'one\ntwo\nthree\n',
        local: 'one\ntwo \nthree\n',
        remote: 'one\n two\nfour\n',
        languageHint: null,
        fileName: 'trivial.txt',
    };
    const trivialMergeResult: ThreeWayMergeResult = {
        auto_merged_text: 'one\ntwo \nthree\n',
        conflict_count: 2,
        hunks: [
            makeHunk({
                start_line: 0,
                end_line: 1,
                kind: 'Unchanged',
                local_text: 'one\n',
                remote_text: 'one\n',
            }),
            makeHunk({
                start_line: 1,
                end_line: 2,
                kind: 'Conflict',
                base_text: 'two\n',
                local_text: 'two \n',
                remote_text: ' two\n',
                merged_text: 'two \n',
            }),
            makeHunk({
                start_line: 2,
                end_line: 3,
                kind: 'Conflict',
                base_text: 'three\n',
                local_text: 'three\n',
                remote_text: 'four\n',
                merged_text: 'three\n',
            }),
        ],
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const view = createThreeWayView(
        container,
        trivialInput,
        trivialMergeResult,
    );
    created.push(view);

    // The whitespace-only conflict is auto-resolved right after mount; the
    // genuine one (different value, not just whitespace) is left untouched.
    expect(view.conflictModel.isResolved(1)).toBe(true);
    expect(view.conflictModel.isResolved(2)).toBe(false);
    expect(view.conflictModel.wasAutoMerged(1)).toBe(true);
    expect(view.conflictModel.wasAutoMerged(2)).toBe(false);
    // Resolves to local's exact bytes (not a normalized/trimmed version).
    const range = view.conflictModel.rangeFor(1);
    expect(view.resultView.state.sliceDoc(range.from, range.to)).toBe('two ');
});

test('a burst of result edits schedules at most one pending re-diff frame', () => {
    const { view, scheduler, pending } = setup();
    const baseline = view.recomputeCount;
    for (let i = 0; i < 25; i++) {
        view.resultView.dispatch({ changes: { from: 0, insert: 'x' } });
    }
    // Each edit replaced the previous frame instead of queueing another.
    expect(scheduler.requests).toBe(25);
    expect(scheduler.cancels).toBe(24);
    expect(pending.size).toBe(1);
    // And no edit re-diffed synchronously.
    expect(view.recomputeCount).toBe(baseline);
    [...pending.values()][0]();
    expect(view.recomputeCount).toBe(baseline + 1);
    // The single incremental re-diff saw all 25 edits.
    expect(changedResultLines(view, 'local')).toContain(1);
});

test('side diffs track the LIVE result: after a pull and a manual edit, highlights follow', () => {
    const { view } = setup();
    // Initially: remote differs on the conflict line and the LocalOnly line.
    expect(changedResultLines(view, 'remote')).toEqual([2, 4]);
    expect(changedResultLines(view, 'local')).toEqual([]);

    pullHunk(view, 1, 'remote');
    view.flushPendingDiff();
    expect(changedResultLines(view, 'remote')).toEqual([4]);
    expect(changedResultLines(view, 'local')).toEqual([2]);

    // Manual edit in an Unchanged region: both sides now differ there.
    const line3 = view.resultView.state.doc.line(3);
    view.resultView.dispatch({
        changes: { from: line3.from, to: line3.to, insert: 'THREE' },
    });
    view.flushPendingDiff();
    expect(changedResultLines(view, 'remote')).toEqual([3, 4]);
    expect(changedResultLines(view, 'local')).toEqual([2, 3]);

    // And the incremental result matches a from-scratch diff.
    const fresh = setup();
    fresh.view.resultView.dispatch({
        changes: {
            from: 0,
            to: fresh.view.resultView.state.doc.length,
            insert: view.resultView.state.doc.toString(),
        },
    });
    fresh.view.flushPendingDiff();
    expect(changedResultLines(fresh.view, 'remote')).toEqual([3, 4]);
});

test('pull arrows: both on an open conflict, otherwise only where pulling would change the result', () => {
    const { view, container } = setup();
    const resultDom = container.querySelector('.tw-pane-result')!;
    // Open conflict: both arrows, even though the result already holds local's
    // text (accepting local is still the resolution). LocalOnly hunk: the
    // result holds local's text, so only "accept remote" is offered.
    expect(resultDom.querySelectorAll('.cm-pull-local')).toHaveLength(1);
    expect(resultDom.querySelectorAll('.cm-pull-remote')).toHaveLength(2);
    // "Accept both" only ever applies to the one genuine Conflict hunk, not
    // the LocalOnly one.
    expect(resultDom.querySelectorAll('.cm-pull-both')).toHaveLength(1);
    expect(
        resultDom.querySelectorAll('.cm-hunk-pill-auto-merged'),
    ).toHaveLength(1);
    (resultDom.querySelector('.cm-pull-remote') as HTMLElement).click();
    expect(view.conflictModel.isResolved(1)).toBe(true);
    // Resolved to remote: only "back to local" remains for it.
    expect(resultDom.querySelectorAll('.cm-pull-local')).toHaveLength(1);
    expect(resultDom.querySelectorAll('.cm-pull-remote')).toHaveLength(1);
    expect(resultDom.querySelectorAll('.cm-hunk-pill-resolved')).toHaveLength(
        1,
    );
});

test('"accept both" stacks local then remote for an open conflict via its toolbar arrow', () => {
    const { view, container } = setup();
    const resultDom = container.querySelector('.tw-pane-result')!;
    (resultDom.querySelector('.cm-pull-both') as HTMLElement).click();
    expect(view.resultView.state.doc.toString()).toBe(
        'one\nlocal two\nremote two\nthree\nfour local\n',
    );
    expect(view.conflictModel.isResolved(1)).toBe(true);
});

test('word diff marks substantive changes and skips whitespace-only ops; toggle hides them', async () => {
    const ops: WordDiffOp[] = [
        { kind: 'Delete', text: 'local' },
        { kind: 'Insert', text: 'remote' },
        { kind: 'Delete', text: ' ' },
        { kind: 'Insert', text: '  ' },
        { kind: 'Equal', text: 'two' },
    ];
    const computeWordDiff = vi.fn(async () => ops);
    const { view, container } = setup({ computeWordDiff });
    await vi.waitFor(() =>
        expect(container.querySelectorAll('.cm-word-local')).toHaveLength(1),
    );
    expect(computeWordDiff).toHaveBeenCalledWith('local two', 'remote two');
    expect(container.querySelector('.cm-word-local')?.textContent).toBe(
        'local',
    );
    expect(container.querySelector('.cm-word-remote')?.textContent).toBe(
        'remote',
    );
    view.setWordDiffEnabled(false);
    expect(container.querySelectorAll('.cm-word-diff')).toHaveLength(0);
});

test('a failing word-diff backend does not throw out of the view', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const computeWordDiff = vi.fn(async () => {
        throw 'backend down';
    });
    setup({ computeWordDiff });
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
});

test('destroy cancels a pending re-diff frame and removes the panes', () => {
    const { view, pending, container } = setup();
    view.resultView.dispatch({ changes: { from: 0, insert: 'x' } });
    expect(pending.size).toBe(1);
    view.destroy();
    expect(pending.size).toBe(0);
    expect(container.querySelectorAll('.tw-pane')).toHaveLength(0);
    // Idempotent (afterEach destroys again).
    expect(() => view.destroy()).not.toThrow();
});

test('edits far apart within one frame are all reflected (changes are composed)', async () => {
    const { Chunk } = await import('@codemirror/merge');
    // Large enough that updateB's ~1000-char re-diff margin around one edit
    // cannot accidentally cover the other.
    const text =
        Array.from({ length: 400 }, (_, i) => `line number ${i}`).join('\n') +
        '\n';
    const big: ThreeWayMergeResult = {
        auto_merged_text: text,
        conflict_count: 0,
        hunks: [
            makeHunk({
                start_line: 0,
                end_line: 400,
                kind: 'Unchanged',
                local_text: text,
                remote_text: text,
            }),
        ],
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    const { scheduler } = manualScheduler();
    const view = createThreeWayView(
        container,
        {
            base: text,
            local: text,
            remote: text,
            languageHint: null,
            fileName: 'big.txt',
        },
        big,
        {
            scheduler,
        },
    );
    created.push(view);
    const r = view.resultView;
    r.dispatch({ changes: { from: r.state.doc.line(2).to, insert: '!' } });
    r.dispatch({ changes: { from: r.state.doc.line(390).to, insert: '?' } });
    view.flushPendingDiff();
    expect(changedResultLines(view, 'local')).toEqual([2, 390]);
    const fresh = Chunk.build(view.localView.state.doc, r.state.doc);
    expect(
        view.liveChunks('local').map((c) => [c.fromA, c.toA, c.fromB, c.toB]),
    ).toEqual(fresh.map((c) => [c.fromA, c.toA, c.fromB, c.toB]));
});

// ---------------------------------------------------------------------------
// Line splitting must match the Rust core exactly: lines end at "\n" ONLY. A
// lone "\r" is ordinary line content (Task 5's data-loss fix). CM6's default
// splitting (/\r\n?|\n/) would treat it as a line break, shifting every
// Rust-computed hunk line index after it and turning the "\r" into "\n" on
// `doc.toString()`.
// ---------------------------------------------------------------------------

function setupWith(viewInput: MergeInputPayload, result: ThreeWayMergeResult) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const { scheduler } = manualScheduler();
    const view = createThreeWayView(container, viewInput, result, {
        scheduler,
    });
    created.push(view);
    return view;
}

// Exactly what `compute_three_way_merge(Some(base), local, remote)` returns
// for these inputs (pinned on the Rust side by
// `lone_cr_line_indices_match_frontend_fixture` in three_way.rs).
const crInput: MergeInputPayload = {
    base: 'p\rq\nL\n',
    local: 'p\rq\nLOCAL\n',
    remote: 'p\rq\nREMOTE\n',
    languageHint: null,
    fileName: 'cr.txt',
};
const crResult: ThreeWayMergeResult = {
    auto_merged_text: 'p\rq\nLOCAL\n',
    conflict_count: 1,
    hunks: [
        makeHunk({
            start_line: 0,
            end_line: 1,
            kind: 'Unchanged',
            local_text: 'p\rq\n',
            remote_text: 'p\rq\n',
            merged_text: 'p\rq\n',
        }),
        makeHunk({
            start_line: 1,
            end_line: 2,
            kind: 'Conflict',
            base_text: 'L\n',
            local_text: 'LOCAL\n',
            remote_text: 'REMOTE\n',
            merged_text: 'LOCAL\n',
        }),
    ],
};

test('a lone \\r is line content, not a line break, in all three panes (matches the Rust core)', () => {
    const view = setupWith(crInput, crResult);
    for (const v of [view.localView, view.resultView, view.remoteView]) {
        expect(v.state.doc.lines).toBe(3); // "p\rq", "<side>", ""
        expect(v.state.doc.line(1).text).toBe('p\rq');
    }
    // Rust's conflict line 1 maps to the CM line that actually holds it.
    const range = view.conflictModel.rangeFor(1);
    expect(view.resultView.state.sliceDoc(range.from, range.to)).toBe('LOCAL');
});

test('saving with no pulls preserves a lone \\r byte-for-byte', () => {
    const view = setupWith(crInput, crResult);
    // `doc.toString()` is exactly what app.ts hands to save_result.
    expect(view.resultView.state.doc.toString()).toBe('p\rq\nLOCAL\n');
});

test('pulling a hunk after a lone \\r edits the right line and keeps the \\r', () => {
    const view = setupWith(crInput, crResult);
    expect(view.pullHunk(1, 'remote')).toBe(true);
    expect(view.resultView.state.doc.toString()).toBe('p\rq\nREMOTE\n');
    expect(view.pullHunk(1, 'local')).toBe(true);
    expect(view.resultView.state.doc.toString()).toBe('p\rq\nLOCAL\n');
    expect(view.pullBoth(1)).toBe(true);
    expect(view.resultView.state.doc.toString()).toBe('p\rq\nLOCAL\nREMOTE\n');
});

test('pulling a conflict whose own line contains a lone \\r replaces the whole Rust line', () => {
    const result: ThreeWayMergeResult = {
        auto_merged_text: 'p\rq\nL\n',
        conflict_count: 1,
        hunks: [
            makeHunk({
                start_line: 0,
                end_line: 1,
                kind: 'Conflict',
                base_text: 'p\rx\n',
                local_text: 'p\rq\n',
                remote_text: 'p\rQ\n',
                merged_text: 'p\rq\n',
            }),
            makeHunk({
                start_line: 1,
                end_line: 2,
                kind: 'Unchanged',
                local_text: 'L\n',
                remote_text: 'L\n',
                merged_text: 'L\n',
            }),
        ],
    };
    const view = setupWith(
        {
            base: 'p\rx\nL\n',
            local: 'p\rq\nL\n',
            remote: 'p\rQ\nL\n',
            languageHint: null,
            fileName: 'cr.txt',
        },
        result,
    );
    expect(
        view.resultView.state.sliceDoc(
            view.conflictModel.rangeFor(0).from,
            view.conflictModel.rangeFor(0).to,
        ),
    ).toBe('p\rq');
    expect(view.pullHunk(0, 'remote')).toBe(true);
    expect(view.resultView.state.doc.toString()).toBe('p\rQ\nL\n');
});

test('pasted/dropped CRLF text is normalized to LF (\\r\\n is no longer a CM6 line break)', async () => {
    const { EditorView } = await import('@codemirror/view');
    const view = setupWith(crInput, crResult);
    const state = view.resultView.state;
    const filtered = state
        .facet(EditorView.clipboardInputFilter)
        .reduce((text, f) => f(text, state), 'x\r\ny\r\nlone\rcr');
    // CRLF becomes a real line break; a lone "\r" is still content.
    expect(filtered).toBe('x\ny\nlone\rcr');
});
