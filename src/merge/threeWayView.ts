import {
    redo as cmRedo,
    undo as cmUndo,
    defaultKeymap,
    history,
    historyKeymap,
    indentWithTab,
    invertedEffects,
    redoDepth,
    undoDepth,
} from '@codemirror/commands';
import { LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { Chunk, type DiffConfig } from '@codemirror/merge';
import {
    type ChangeDesc,
    Compartment,
    EditorState,
    type Extension,
    type Range,
    StateEffect,
    StateField,
    type Text,
    type Transaction,
} from '@codemirror/state';
import {
    Decoration,
    type DecorationSet,
    drawSelection,
    EditorView,
    highlightActiveLine,
    highlightActiveLineGutter,
    highlightSpecialChars,
    keymap,
    lineNumbers,
    scrollPastEnd,
    ViewPlugin,
    type ViewUpdate,
    WidgetType,
} from '@codemirror/view';
import { classHighlighter } from '@lezer/highlight';
import type {
    Hunk,
    MergeInputPayload,
    ThreeWayMergeResult,
    WordDiffOp,
} from '../bindings';
import {
    ConflictModel,
    hunkContentMatchesSource,
    isWhitespaceOnlyConflict,
} from './conflictModel';
import {
    type ConnectorGeometry,
    computeConnectorGeometry,
    ribbonPath,
    type Span,
} from './hunkConnectors';
import { hunkIndexAt as hunkIndexForCursor } from './hunkNav';
import { computePullChange } from './pullChange';
import { wordDiffRanges } from './wordDiff';

export type Side = 'local' | 'remote';

/** Frame scheduler; injectable so tests can observe/flush coalescing. */
export interface FrameScheduler {
    request(callback: () => void): number;
    cancel(handle: number): void;
}

export interface ThreeWayViewOptions {
    /** Word-diff backend (the `compute_word_diff` IPC command in the app). Omit to disable word diff. */
    computeWordDiff?: (
        oldText: string,
        newText: string,
    ) => Promise<WordDiffOp[]>;
    /** Whether word-level highlights start enabled (default true). */
    wordDiff?: boolean;
    /** Called after every result-pane update (edit, selection move, resolution change). */
    onUpdate?: () => void;
    scheduler?: FrameScheduler;
    /** Labels shown after the pane names, e.g. "HEAD". */
    localLabel?: string;
    remoteLabel?: string;
    /** Persisted LOCAL/REMOTE pane widths (CSS px) to restore on mount. Falls back to the CSS default (400px) when omitted. */
    paneWidths?: { local: number; remote: number };
    /** Called once a divider drag ends, with the new LOCAL/REMOTE pane widths (CSS px), so the caller can persist them. */
    onPaneWidthsChange?: (widths: { local: number; remote: number }) => void;
    /** Called whenever the result editor's undo/redo availability may have changed. */
    onHistoryChange?: (state: { canUndo: boolean; canRedo: boolean }) => void;
}

/** Keeps a side pane usable and the result pane from being squeezed away by a drag. */
const MIN_SIDE_PANE_WIDTH = 220;
const MIN_RESULT_PANE_WIDTH = 240;

export interface ThreeWayView {
    localView: EditorView;
    resultView: EditorView;
    remoteView: EditorView;
    conflictModel: ConflictModel;
    hunks: readonly Hunk[];
    /** Replaces the hunk's live result range with `side`'s text and marks it resolved. Returns false if nothing changed. */
    pullHunk(hunkIndex: number, side: Side): boolean;
    /**
     * PhpStorm-style "accept this side" — the arrows in the RESULT pane
     * (and the ⌥⌘←/⌥⌘→ keybindings) use this instead of `pullHunk`. If the
     * OTHER side is already cleanly in place, this appends `side` after it
     * (stacking both, in click order — whichever side was accepted first
     * stays on top) rather than replacing it; otherwise it's a plain
     * `pullHunk`. Returns false if nothing changed.
     */
    acceptSide(hunkIndex: number, side: Side): boolean;
    /**
     * Replaces the hunk's live result range with BOTH sides' text (local's
     * lines followed by remote's) and marks it resolved in one step,
     * regardless of the hunk's current state — unlike `acceptSide`, which
     * only stacks when the other side is already cleanly in place. See
     * "Accept both" semantics in `keymap.ts` for why this order was chosen.
     * Returns false if nothing changed.
     */
    pullBoth(hunkIndex: number): boolean;
    /**
     * PhpStorm-style "Accept Left"/"Accept Right": replaces the ENTIRE
     * result document with the full local or full remote file, and marks
     * every hunk resolved. For the caller to save and close right after —
     * not meant to be followed by further per-hunk edits.
     */
    acceptWholeSide(side: Side): void;
    /**
     * PhpStorm-style "Resolve Simple Conflicts": pulls local's text into
     * every still-unresolved `Conflict` hunk where local and remote agree
     * modulo whitespace (see `isWhitespaceOnlyConflict`) — the one class of
     * conflict safe to resolve mechanically. Genuine conflicts and
     * already-resolved hunks are left untouched. Returns the number of
     * hunks resolved.
     */
    resolveSimpleConflicts(): number;
    /**
     * Index of the hunk the result cursor at offset `pos` is on (hunks tile
     * the document). A zero-width conflict at `pos` wins over the hunk that
     * starts at the same offset after it — see `hunkNav.hunkIndexAt`.
     */
    hunkIndexAt(pos: number): number;
    /** Moves the result cursor to the hunk and scrolls it into view. */
    focusHunk(hunkIndex: number): void;
    setWordDiffEnabled(enabled: boolean): void;
    /** The current side-vs-live-result chunks (A = side doc, B = result doc). */
    liveChunks(side: Side): readonly Chunk[];
    /** Runs a pending (frame-scheduled) side re-diff immediately, if one is pending. */
    flushPendingDiff(): void;
    /** Number of side re-diffs performed so far (diagnostics/tests). */
    readonly recomputeCount: number;
    /** Undoes the last result-pane edit/hunk resolution. Returns false if there's nothing to undo. */
    undo(): boolean;
    /** Redoes the last undone result-pane edit/hunk resolution. Returns false if there's nothing to redo. */
    redo(): boolean;
    canUndo(): boolean;
    canRedo(): boolean;
    destroy(): void;
}

// ---------------------------------------------------------------------------
// Hunk state as an undoable effect
// ---------------------------------------------------------------------------

interface HunkSnapshot {
    range: { from: number; to: number };
    resolved: boolean;
    coversLines: boolean;
}

interface HunkStateChange extends HunkSnapshot {
    index: number;
    /** State before this change; used to build the inverse for undo/redo. */
    prev: HunkSnapshot;
}

function mapRange(
    range: { from: number; to: number },
    mapping: ChangeDesc,
): { from: number; to: number } {
    const from = mapping.mapPos(range.from, -1);
    return { from, to: Math.max(from, mapping.mapPos(range.to, 1)) };
}

/**
 * Sets a hunk's tracked range/resolution in the ConflictModel. Carried by
 * pull transactions so that CM6's history can undo/redo a pull INCLUDING its
 * resolution state and its canonical range — position mapping alone can't
 * restore either (see `pullChange.ts`).
 */
const hunkStateEffect = StateEffect.define<HunkStateChange>({
    map: (value, mapping) => ({
        ...value,
        range: mapRange(value.range, mapping),
        prev: { ...value.prev, range: mapRange(value.prev.range, mapping) },
    }),
});

const invertHunkState = invertedEffects.of((tr) =>
    tr.effects
        .filter((e) => e.is(hunkStateEffect))
        .map((e) => {
            const v = e.value as HunkStateChange;
            return hunkStateEffect.of({
                index: v.index,
                ...v.prev,
                prev: {
                    range: v.range,
                    resolved: v.resolved,
                    coversLines: v.coversLines,
                },
            });
        }),
);

// ---------------------------------------------------------------------------
// Side-pane decorations (pushed in from the frame-coalesced re-diff)
// ---------------------------------------------------------------------------

const setSideDecorations = StateEffect.define<DecorationSet>();

const sideDecorationsField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(value, tr) {
        for (const e of tr.effects)
            if (e.is(setSideDecorations)) return e.value;
        return value.map(tr.changes);
    },
    provide: (field) => EditorView.decorations.from(field),
});

// ---------------------------------------------------------------------------
// Result-pane hunk controls widget (pull arrows + status pill)
// ---------------------------------------------------------------------------

class HunkControlsWidget extends WidgetType {
    constructor(
        readonly index: number,
        readonly canPullLocal: boolean,
        readonly canPullRemote: boolean,
        readonly pill: string | null,
        readonly onPull: (index: number, side: Side) => void,
    ) {
        super();
    }

    eq(other: HunkControlsWidget): boolean {
        return (
            other.index === this.index &&
            other.canPullLocal === this.canPullLocal &&
            other.canPullRemote === this.canPullRemote &&
            other.pill === this.pill
        );
    }

    toDOM(): HTMLElement {
        const wrap = document.createElement('span');
        wrap.className = 'cm-hunk-controls';
        wrap.setAttribute('aria-hidden', 'false');
        if (this.canPullLocal)
            wrap.appendChild(
                this.button('local', '←', 'Accept local for this hunk'),
            );
        // Pill + remote arrow share ONE sticky-right-anchored group (rather
        // than each being independently `position: sticky; right: Npx`) so
        // they lay out side-by-side with a real CSS gap instead of two fixed
        // offsets that assume a fixed pill width — "auto-merged" is wider
        // than "resolved" and would otherwise crowd/overlap the arrow.
        if (this.pill || this.canPullRemote) {
            const group = document.createElement('span');
            group.className = 'cm-hunk-right-group';
            if (this.pill) {
                const pill = document.createElement('span');
                pill.className = `cm-hunk-pill cm-hunk-pill-${this.pill.replace(/\s+/g, '-')}`;
                pill.textContent = this.pill;
                group.appendChild(pill);
            }
            if (this.canPullRemote)
                group.appendChild(
                    this.button('remote', '→', 'Accept remote for this hunk'),
                );
            wrap.appendChild(group);
        }
        return wrap;
    }

    private button(side: Side, glyph: string, title: string): HTMLElement {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `cm-pull-arrow cm-pull-${side}`;
        button.textContent = glyph;
        button.title = title;
        button.setAttribute('aria-label', title);
        // Keep editor focus/selection untouched by the click.
        button.addEventListener('mousedown', (event) => event.preventDefault());
        button.addEventListener('click', (event) => {
            event.preventDefault();
            this.onPull(this.index, side);
        });
        return button;
    }

    ignoreEvent(): boolean {
        return true;
    }
}

// ---------------------------------------------------------------------------
// Shared editor setup
// ---------------------------------------------------------------------------

const DIFF_CONFIG: DiffConfig = { scanLimit: 500, timeout: 200 };

const baseTheme = EditorView.theme({
    '&': { height: '100%' },
    '.cm-scroller': { overflow: 'auto', position: 'relative' },
});

/**
 * Lines end at "\n" ONLY, exactly like the Rust core's `split_lines`
 * (`three_way.rs`). CM6's default splits on /\r\n?|\n/, which treats a lone
 * "\r" as its own line break: every Rust hunk line index after it would then
 * point at the wrong CM6 line (pulls edit the wrong text), and
 * `doc.toString()` would rewrite the "\r" to "\n" on save. Must be applied
 * wherever a document is created from merge text — all three panes AND the
 * initial result state the ConflictModel maps line indices against.
 */
export const LINE_SEPARATOR: Extension = EditorState.lineSeparator.of('\n');

function commonExtensions(language: Compartment): Extension[] {
    return [
        LINE_SEPARATOR,
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        drawSelection(),
        highlightActiveLine(),
        syntaxHighlighting(classHighlighter),
        // Lets a shorter side document still scroll far enough to stay
        // line-aligned with the result near the end (see syncScroll).
        scrollPastEnd(),
        language.of([]),
        baseTheme,
    ];
}

function defaultScheduler(): FrameScheduler {
    if (typeof requestAnimationFrame === 'function') {
        return {
            request: (cb) => requestAnimationFrame(() => cb()),
            cancel: (handle) => cancelAnimationFrame(handle),
        };
    }
    return {
        request: (cb) => setTimeout(cb, 16) as unknown as number,
        cancel: (handle) => clearTimeout(handle),
    };
}

function linesOf(doc: Text, startLine: number, endLine: number): number[] {
    // 0-based, end-exclusive line range -> CM line numbers (1-based), clamped.
    const out: number[] = [];
    for (let n = startLine + 1; n <= Math.min(endLine, doc.lines); n++)
        out.push(n);
    return out;
}

/** Line whose top edge marks a zero-width region at 0-based line `line`. */
function gapLine(doc: Text, line: number): { number: number; atEnd: boolean } {
    return line < doc.lines
        ? { number: line + 1, atEnd: false }
        : { number: doc.lines, atEnd: true };
}

// ---------------------------------------------------------------------------
// The composition
// ---------------------------------------------------------------------------

/**
 * Builds the 3-pane merge view: LOCAL (read-only) | RESULT (editable) |
 * REMOTE (read-only), as three independently owned `EditorView`s.
 *
 * `@codemirror/merge`'s `MergeView` is 2-way only and owns its editors, so
 * it is not used. Instead:
 *
 * - Every result transaction is fed to the `ConflictModel` (in
 *   `dispatchTransactions`, BEFORE the view updates, so the result pane's
 *   decorations always read up-to-date ranges).
 * - Each side pane's changed-line highlighting comes from `Chunk.build` /
 *   `Chunk.updateB` (the `diff()`-based primitives of `@codemirror/merge`)
 *   run between that side's (static) document and the LIVE result document.
 *   That re-diff is coalesced into at most one pending animation frame: each
 *   result change cancels any already-scheduled frame and schedules a new
 *   one, and the ChangeDescs since the last re-diff are composed so the
 *   frame does a single incremental `Chunk.updateB` per side.
 * - Pulling a hunk is a hand-written transaction over
 *   `conflictModel.rangeFor(i)` (see `pullChange.ts`), carrying an undoable
 *   `hunkStateEffect` that marks the hunk resolved.
 */
export function createThreeWayView(
    container: HTMLElement,
    input: MergeInputPayload,
    mergeResult: ThreeWayMergeResult,
    options: ThreeWayViewOptions = {},
): ThreeWayView {
    const hunks = mergeResult.hunks;
    const scheduler = options.scheduler ?? defaultScheduler();
    const language = new Compartment();
    let wordDiffEnabled = options.wordDiff ?? true;
    let destroyed = false;

    // --- DOM skeleton ------------------------------------------------------
    container.classList.add('tw-root');
    const panes = document.createElement('div');
    panes.className = 'tw-panes';
    const makePane = (
        kind: 'local' | 'result' | 'remote',
        label: string,
        sub: string,
    ) => {
        const pane = document.createElement('section');
        pane.className = `tw-pane tw-pane-${kind}`;
        const header = document.createElement('header');
        header.className = 'tw-pane-header';
        const dot = document.createElement('span');
        dot.className = 'tw-dot';
        const name = document.createElement('span');
        name.className = 'tw-pane-label';
        name.textContent = label;
        const subLabel = document.createElement('span');
        subLabel.className = 'tw-pane-sub';
        subLabel.textContent = sub ? `· ${sub}` : '';
        header.append(dot, name, subLabel);
        const editor = document.createElement('div');
        editor.className = 'tw-editor';
        pane.append(header, editor);
        panes.appendChild(pane);
        return { root: pane, header, editor };
    };
    const makeDivider = (resizes: 'local' | 'remote') => {
        const divider = document.createElement('div');
        divider.className = 'tw-divider';
        const spacer = document.createElement('div');
        spacer.className = 'tw-divider-spacer';
        const body = document.createElement('div');
        body.className = 'tw-divider-body';
        const svg = document.createElementNS(
            'http://www.w3.org/2000/svg',
            'svg',
        );
        svg.setAttribute('class', 'tw-connector-svg');
        body.appendChild(svg);
        divider.append(spacer, body);
        divider.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            // A ribbon connector owns its own click-to-navigate; don't start
            // a resize drag when the pointer came down on one.
            if (event.target instanceof SVGPathElement) return;
            event.preventDefault();
            const pane = (resizes === 'local' ? localPane : remotePane).root;
            const startX = event.clientX;
            const startWidth = pane.getBoundingClientRect().width;
            const containerWidth = panes.getBoundingClientRect().width;
            const otherSideWidth = (
                resizes === 'local' ? remotePane : localPane
            ).root.getBoundingClientRect().width;
            const dividerWidths =
                localDividerParts.divider.getBoundingClientRect().width +
                remoteDividerParts.divider.getBoundingClientRect().width;
            const maxWidth = Math.max(
                MIN_SIDE_PANE_WIDTH,
                containerWidth -
                    otherSideWidth -
                    dividerWidths -
                    MIN_RESULT_PANE_WIDTH,
            );
            divider.setPointerCapture(event.pointerId);
            const onMove = (moveEvent: PointerEvent) => {
                const delta = moveEvent.clientX - startX;
                const signedDelta = resizes === 'local' ? delta : -delta;
                const width = Math.min(
                    maxWidth,
                    Math.max(MIN_SIDE_PANE_WIDTH, startWidth + signedDelta),
                );
                pane.style.flexBasis = `${width}px`;
            };
            const onUp = () => {
                divider.removeEventListener('pointermove', onMove);
                divider.removeEventListener('pointerup', onUp);
                options.onPaneWidthsChange?.({
                    local: localPane.root.getBoundingClientRect().width,
                    remote: remotePane.root.getBoundingClientRect().width,
                });
            };
            divider.addEventListener('pointermove', onMove);
            divider.addEventListener('pointerup', onUp);
        });
        divider.addEventListener('dblclick', () => {
            const pane = (resizes === 'local' ? localPane : remotePane).root;
            pane.style.flexBasis = '';
            options.onPaneWidthsChange?.({
                local: localPane.root.getBoundingClientRect().width,
                remote: remotePane.root.getBoundingClientRect().width,
            });
        });
        return { divider, svg };
    };
    const localPane = makePane('local', 'LOCAL', options.localLabel ?? 'HEAD');
    if (options.paneWidths)
        localPane.root.style.flexBasis = `${options.paneWidths.local}px`;
    const localDividerParts = makeDivider('local');
    panes.appendChild(localDividerParts.divider);
    const resultPane = makePane('result', 'RESULT', 'editable');
    const remoteDividerParts = makeDivider('remote');
    panes.appendChild(remoteDividerParts.divider);
    const remotePane = makePane('remote', 'REMOTE', options.remoteLabel ?? '');
    if (options.paneWidths)
        remotePane.root.style.flexBasis = `${options.paneWidths.remote}px`;
    const unresolvedPill = document.createElement('span');
    unresolvedPill.className = 'tw-unresolved-pill';
    resultPane.header.appendChild(unresolvedPill);
    container.appendChild(panes);

    // --- Side panes ---------------------------------------------------------
    const sideExtensions = [
        ...commonExtensions(language),
        EditorState.readOnly.of(true),
        sideDecorationsField,
    ];
    const localView = new EditorView({
        parent: localPane.editor,
        state: EditorState.create({
            doc: input.local,
            extensions: sideExtensions,
        }),
    });
    const remoteView = new EditorView({
        parent: remotePane.editor,
        state: EditorState.create({
            doc: input.remote,
            extensions: sideExtensions,
        }),
    });

    // --- Result pane --------------------------------------------------------
    const resultState0 = EditorState.create({
        doc: mergeResult.auto_merged_text,
        extensions: LINE_SEPARATOR,
    });
    const conflictModel = new ConflictModel(hunks, resultState0.doc);
    // Disambiguates zero-width vs one-empty-line ranges (see pullChange.ts).
    const coversLines = hunks.map((h) => h.end_line > h.start_line);

    let pendingChanges: ChangeDesc | null = null;
    let frame: number | null = null;
    let recomputeCount = 0;
    let chunksBuilt = false;
    const chunks: Record<Side, readonly Chunk[]> = { local: [], remote: [] };
    const wordMarks: Record<Side, { from: number; to: number }[]> = {
        local: [],
        remote: [],
    };

    const sideText = (index: number, side: Side) =>
        side === 'local' ? hunks[index].local_text : hunks[index].remote_text;

    const hunkIsCovering = (index: number) => {
        const range = conflictModel.rangeFor(index);
        return coversLines[index] || range.from !== range.to;
    };

    function buildResultDecorations(view: EditorView): DecorationSet {
        const doc = view.state.doc;
        const decos: Range<Decoration>[] = [];
        const selectedIndex = hunkIndexForCursor(
            conflictModel,
            hunks,
            view.state.selection.main.head,
        );
        for (let i = 0; i < hunks.length; i++) {
            const hunk = hunks[i];
            if (hunk.kind === 'Unchanged') continue;
            const range = conflictModel.rangeFor(i);
            if (range.from > doc.length || range.to > doc.length) continue;
            const resolved = conflictModel.isResolved(i);
            // Content-aware highlighting: a resolved/auto-merged (green)
            // hunk whose live text no longer matches any source it could
            // have come from (local, remote, or both stacked) has been hand-
            // edited/pasted into since — flag it distinctly rather than
            // silently keeping the stale "resolved" color. Unresolved
            // conflicts (yellow) are untouched: "needs a decision" stays
            // true regardless of what the user has typed in the meantime.
            const edited =
                (hunk.kind !== 'Conflict' || resolved) &&
                !hunkContentMatchesSource(doc, range, hunk);
            const cls =
                hunk.kind === 'Conflict'
                    ? resolved
                        ? edited
                            ? 'cm-hunk-edited'
                            : 'cm-hunk-resolved'
                        : 'cm-hunk-conflict'
                    : edited
                      ? 'cm-hunk-edited'
                      : 'cm-hunk-auto';
            const covering = hunkIsCovering(i);
            const firstLine = doc.lineAt(range.from);
            if (covering) {
                const lastLine = doc.lineAt(range.to);
                const selected = i === selectedIndex;
                for (let n = firstLine.number; n <= lastLine.number; n++) {
                    let lineCls = cls;
                    if (n === firstLine.number) lineCls += ' cm-hunk-first';
                    if (n === lastLine.number) lineCls += ' cm-hunk-last';
                    if (selected) {
                        if (n === firstLine.number)
                            lineCls += ' cm-hunk-selected-first';
                        if (n === lastLine.number)
                            lineCls += ' cm-hunk-selected-last';
                        if (n !== firstLine.number && n !== lastLine.number)
                            lineCls += ' cm-hunk-selected-middle';
                    }
                    decos.push(
                        Decoration.line({ class: lineCls }).range(
                            doc.line(n).from,
                        ),
                    );
                }
            } else {
                const atEnd =
                    range.from === doc.length && firstLine.from !== range.from;
                decos.push(
                    Decoration.line({
                        class: `${cls} cm-hunk-gap${atEnd ? ' cm-hunk-gap-end' : ''}`,
                    }).range(firstLine.from),
                );
            }
            // Arrows reflect the current state: shown only where pulling would
            // change the result — except on an unresolved conflict, where both
            // are always offered, since picking the side the result already
            // matches is itself the resolution.
            const open = hunk.kind === 'Conflict' && !resolved;
            const canPullLocal =
                open ||
                computePullChange(doc, range, hunk.local_text, covering) !==
                    null;
            const canPullRemote =
                open ||
                computePullChange(doc, range, hunk.remote_text, covering) !==
                    null;
            const pill = edited
                ? 'edited'
                : conflictModel.wasAutoMerged(i)
                  ? 'auto-merged'
                  : hunk.kind === 'Conflict' && resolved
                    ? 'resolved'
                    : null;
            if (canPullLocal || canPullRemote || pill) {
                decos.push(
                    Decoration.widget({
                        widget: new HunkControlsWidget(
                            i,
                            canPullLocal,
                            canPullRemote,
                            pill,
                            (index, side) => {
                                acceptSide(index, side);
                            },
                        ),
                        side: -1,
                    }).range(firstLine.from),
                );
            }
        }
        return Decoration.set(decos, true);
    }

    const resultDecorations = ViewPlugin.fromClass(
        class {
            decorations: DecorationSet;
            constructor(view: EditorView) {
                this.decorations = buildResultDecorations(view);
            }
            update(update: ViewUpdate) {
                const relevant =
                    update.docChanged ||
                    update.selectionSet ||
                    update.transactions.some((tr) =>
                        tr.effects.some((e) => e.is(hunkStateEffect)),
                    );
                if (relevant)
                    this.decorations = buildResultDecorations(update.view);
            }
        },
        { decorations: (plugin) => plugin.decorations },
    );

    const resultView = new EditorView({
        parent: resultPane.editor,
        state: EditorState.create({
            doc: resultState0.doc,
            extensions: [
                ...commonExtensions(language),
                history(),
                invertHunkState,
                keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
                // With "\n" as the only line separator (LINE_SEPARATOR), pasted or
                // dropped CRLF text would otherwise keep its "\r"s as line content.
                // Normalize it like the inputs are (Rust's load_merge_input); a
                // lone "\r" is still kept, matching the Rust core.
                EditorView.clipboardInputFilter.of((text) =>
                    text.replace(/\r\n/g, '\n'),
                ),
                resultDecorations,
                EditorView.updateListener.of((update) => {
                    if (
                        update.docChanged ||
                        update.selectionSet ||
                        update.transactions.some((tr) => tr.effects.length)
                    ) {
                        updateHeader();
                        options.onUpdate?.();
                    }
                    if (
                        update.docChanged ||
                        update.transactions.some((tr) => tr.effects.length)
                    ) {
                        options.onHistoryChange?.({
                            canUndo: undoDepth(update.state) > 0,
                            canRedo: redoDepth(update.state) > 0,
                        });
                    }
                }),
            ],
        }),
        dispatchTransactions(trs: readonly Transaction[], view: EditorView) {
            let touched = false;
            for (const tr of trs) {
                if (tr.docChanged) {
                    conflictModel.applyEdit(tr.changes);
                    pendingChanges = pendingChanges
                        ? pendingChanges.composeDesc(tr.changes.desc)
                        : tr.changes.desc;
                    touched = true;
                }
                for (const effect of tr.effects) {
                    if (!effect.is(hunkStateEffect)) continue;
                    const v = effect.value;
                    conflictModel.setRange(v.index, v.range);
                    if (v.resolved) conflictModel.markResolved(v.index);
                    else conflictModel.markUnresolved(v.index);
                    coversLines[v.index] = v.coversLines;
                    touched = true;
                }
            }
            view.update(trs);
            if (touched) scheduleRediff();
        },
    });

    // --- Live side re-diff (frame-coalesced) --------------------------------
    function scheduleRediff() {
        if (destroyed) return;
        if (frame !== null) scheduler.cancel(frame);
        frame = scheduler.request(() => {
            frame = null;
            rediff();
        });
    }

    function rediff() {
        if (destroyed) return;
        recomputeCount++;
        const resultDoc = resultView.state.doc;
        for (const side of ['local', 'remote'] as const) {
            const sideDoc = (side === 'local' ? localView : remoteView).state
                .doc;
            if (!chunksBuilt) {
                chunks[side] = Chunk.build(sideDoc, resultDoc, DIFF_CONFIG);
            } else if (pendingChanges) {
                // Incremental: only the regions touched by the composed changes
                // since the last frame are re-diffed.
                chunks[side] = Chunk.updateB(
                    chunks[side],
                    sideDoc,
                    resultDoc,
                    pendingChanges,
                    DIFF_CONFIG,
                );
            }
            // else: only resolution state changed; chunks are still current.
        }
        chunksBuilt = true;
        pendingChanges = null;
        pushSideDecorations();
        // Not scheduled via scheduleConnectorRender: rediff() itself already
        // runs inside a debounced frame (scheduleRediff) or an explicit
        // flush, so rendering connectors synchronously here avoids queuing a
        // second, redundant frame request on every edit.
        renderConnectors();
    }

    function pushSideDecorations() {
        for (const side of ['local', 'remote'] as const) {
            const view = side === 'local' ? localView : remoteView;
            const doc = view.state.doc;
            const decos: Range<Decoration>[] = [];
            const liveCls = `cm-live-diff cm-live-diff-${side}`;
            for (const chunk of chunks[side]) {
                if (chunk.fromA < chunk.toA) {
                    const first = doc.lineAt(chunk.fromA).number;
                    const last = doc.lineAt(chunk.endA).number;
                    for (let n = first; n <= last; n++) {
                        let lineCls = liveCls;
                        if (n === first) lineCls += ' cm-live-diff-first';
                        if (n === last) lineCls += ' cm-live-diff-last';
                        decos.push(
                            Decoration.line({ class: lineCls }).range(
                                doc.line(n).from,
                            ),
                        );
                    }
                } else {
                    const pos = Math.min(chunk.fromA, doc.length);
                    const line = doc.lineAt(pos);
                    const atEnd = pos === doc.length && line.from !== pos;
                    decos.push(
                        Decoration.line({
                            class: `${liveCls} cm-live-gap${atEnd ? ' cm-live-gap-end' : ''}`,
                        }).range(line.from),
                    );
                }
            }
            for (let i = 0; i < hunks.length; i++) {
                const hunk = hunks[i];
                let cls: string | null;
                if (hunk.kind === 'Conflict') {
                    cls = conflictModel.isResolved(i)
                        ? 'cm-hunk-resolved'
                        : 'cm-hunk-conflict';
                } else if (
                    (hunk.kind === 'LocalOnly' && side === 'local') ||
                    (hunk.kind === 'RemoteOnly' && side === 'remote') ||
                    hunk.kind === 'SameChange'
                ) {
                    // Marks the origin side(s) of an auto-merged hunk even
                    // after the live diff shows no difference from the
                    // result, so it stays visible where it came from.
                    cls = 'cm-hunk-auto';
                } else {
                    cls = null;
                }
                if (cls === null) continue;
                const start =
                    side === 'local'
                        ? hunk.local_start_line
                        : hunk.remote_start_line;
                const end =
                    side === 'local'
                        ? hunk.local_end_line
                        : hunk.remote_end_line;
                const lines = linesOf(doc, start, end);
                if (lines.length) {
                    lines.forEach((n, k) => {
                        let lineCls = cls;
                        if (k === 0) lineCls += ' cm-hunk-first';
                        if (k === lines.length - 1) lineCls += ' cm-hunk-last';
                        decos.push(
                            Decoration.line({ class: lineCls }).range(
                                doc.line(n).from,
                            ),
                        );
                    });
                } else {
                    const gap = gapLine(doc, start);
                    decos.push(
                        Decoration.line({
                            class: `${cls} cm-hunk-gap${gap.atEnd ? ' cm-hunk-gap-end' : ''}`,
                        }).range(doc.line(gap.number).from),
                    );
                }
            }
            if (wordDiffEnabled) {
                for (const mark of wordMarks[side]) {
                    if (mark.to <= doc.length && mark.from < mark.to) {
                        decos.push(
                            Decoration.mark({
                                class: `cm-word-diff cm-word-${side}`,
                            }).range(mark.from, mark.to),
                        );
                    }
                }
            }
            view.dispatch({
                effects: setSideDecorations.of(Decoration.set(decos, true)),
            });
        }
    }

    // --- Connector ribbons (visual mapping of side lines to result lines) ---
    // One SVGPathElement per divider, keyed by hunk index and reused across
    // frames (hunks.length never changes post-mount, so the pool is a fixed
    // size allocated once).
    const localPathPool: SVGPathElement[] = hunks.map((_, i) =>
        makeConnectorPath(localDividerParts.svg, i),
    );
    const remotePathPool: SVGPathElement[] = hunks.map((_, i) =>
        makeConnectorPath(remoteDividerParts.svg, i),
    );
    function makeConnectorPath(
        svg: SVGSVGElement,
        hunkIndex: number,
    ): SVGPathElement {
        const path = document.createElementNS(
            'http://www.w3.org/2000/svg',
            'path',
        );
        path.style.display = 'none';
        path.dataset.hunkIndex = String(hunkIndex);
        path.addEventListener('click', () => focusHunk(hunkIndex));
        svg.appendChild(path);
        return path;
    }
    // Replaces a pooled path with a brand new element carrying the same
    // attributes, instead of mutating the existing node's `d` in place.
    // WKWebView has been observed leaving a stale (sometimes visibly
    // tiled/repeated) paint of a long-lived path during fast/continuous
    // scrolling of the adjacent pane content, that nothing short of an
    // unrelated forced style recalc (hovering the path, a focus change)
    // would flush — a fresh node has no stale backing-store association to
    // begin with, so there's nothing to flush.
    function replaceConnectorPath(
        svg: SVGSVGElement,
        old: SVGPathElement,
        hunkIndex: number,
        cls: string,
        d: string,
    ): SVGPathElement {
        const path = document.createElementNS(
            'http://www.w3.org/2000/svg',
            'path',
        );
        path.dataset.hunkIndex = String(hunkIndex);
        path.addEventListener('click', () => focusHunk(hunkIndex));
        path.setAttribute('class', cls);
        path.setAttribute('d', d);
        svg.replaceChild(path, old);
        return path;
    }

    let connectorFrame: number | null = null;
    // Leading + guaranteed trailing: the first call in a quiet period draws
    // right away (no one-frame wait, so connectors never visibly trail a
    // quick scroll reversal), and a second pass always follows one frame
    // later. The trailing pass isn't just for coalescing further calls
    // during the frame — CodeMirror's own internal viewport remeasure after
    // a scroll is itself deferred to the next animation frame, so a
    // `lineBlockAt` read made synchronously inside the same scroll/resize
    // event that triggered this call can reflect pre-scroll layout for one
    // frame. Without the unconditional trailing pass, a lone scroll tick's
    // leading render could stay wrong forever (nothing else re-renders it).
    function scheduleConnectorRender() {
        if (destroyed) return;
        // Always draw immediately with whatever scrollTop/geometry is
        // current right now — never skip this because a frame is already
        // pending. Under a fast/continuous scroll burst (rapid wheel
        // events, a flung trackpad scroll), events can arrive faster than
        // one animation frame apart; skipping the synchronous draw here
        // left the ribbon showing a stale position for the whole burst,
        // only snapping to correct once the single trailing rAF finally
        // got a turn. The rAF below is just a safety net for CodeMirror's
        // own deferred internal remeasure (e.g. after a decoration change),
        // not the primary way this draws.
        renderConnectors();
        if (connectorFrame !== null) return;
        connectorFrame = scheduler.request(() => {
            connectorFrame = null;
            renderConnectors();
        });
    }

    function renderConnectors() {
        if (destroyed) return;
        const geometry = computeConnectorGeometry(
            hunks,
            conflictModel,
            hunkIsCovering,
            localView,
            resultView,
            remoteView,
        );
        // `lineBlockAt`-based spans are relative to each pane's own CM6
        // content-coordinate origin, which doesn't necessarily land on the
        // divider SVG's y=0 (comparing `resultView.scrollDOM`'s own
        // bounding rect to the SVG's turned out NOT to account for the
        // actual gap — empirically it's zero). Measure the real discrepancy
        // directly instead: take the RESULT pane's first actual rendered
        // `.cm-line` element, compare where `lineBlockAt` says it should
        // land (in the same SVG-local coordinate space `ribbonPath` draws
        // in) against where it's really rendered, and correct by the
        // difference. Self-calibrating against whatever the true cause is
        // (CM6 content padding, gutter/content alignment, etc.) rather than
        // hardcoding a guessed constant.
        //
        // CM6 virtualizes line rendering: once scrolled, the first `.cm-line`
        // actually mounted in the DOM is whichever line now sits at the top
        // of the viewport, NOT document line 1. `lineBlockAt` must be asked
        // about that SAME line (via `posAtDOM`) rather than position 0 —
        // comparing line 1's position against some other line's real
        // position produced an error that grew with scroll offset instead of
        // a small constant, so connectors drifted further the more you
        // scrolled and never resolved themselves.
        const firstLineDom = resultPane.editor.querySelector('.cm-line');
        const svgTop = localDividerParts.svg.getBoundingClientRect().top;
        let yCorrection = 0;
        if (firstLineDom) {
            const pos = resultView.posAtDOM(firstLineDom);
            const firstBlock = resultView.lineBlockAt(pos);
            const computedY = firstBlock.top - resultView.scrollDOM.scrollTop;
            const realY = firstLineDom.getBoundingClientRect().top - svgTop;
            yCorrection = realY - computedY;
        }
        const shift = (span: Span): Span => ({
            top: span.top + yCorrection,
            bottom: span.bottom + yCorrection,
        });
        const shown = new Set(geometry.map((g) => g.index));
        const localWidth = localDividerParts.svg.clientWidth;
        const remoteWidth = remoteDividerParts.svg.clientWidth;
        for (const g of geometry) {
            const baseCls = `tw-connector tw-connector-${g.style}`;
            const local = shift(g.local);
            const result = shift(g.result);
            const remote = shift(g.remote);
            localPathPool[g.index] = replaceConnectorPath(
                localDividerParts.svg,
                localPathPool[g.index],
                g.index,
                g.localHasGap ? `${baseCls} tw-connector-gap` : baseCls,
                ribbonPath(localWidth, local, result, g.localHasGap ? 2 : 1),
            );
            remotePathPool[g.index] = replaceConnectorPath(
                remoteDividerParts.svg,
                remotePathPool[g.index],
                g.index,
                g.remoteHasGap ? `${baseCls} tw-connector-gap` : baseCls,
                ribbonPath(remoteWidth, result, remote, g.remoteHasGap ? 2 : 1),
            );
        }
        for (let i = 0; i < hunks.length; i++) {
            if (shown.has(i)) continue;
            localPathPool[i].style.display = 'none';
            remotePathPool[i].style.display = 'none';
        }
    }

    // --- Word diff (static: local vs remote inside each conflict) -----------
    async function loadWordDiffs() {
        const compute = options.computeWordDiff;
        if (!compute) return;
        const localDoc = localView.state.doc;
        const remoteDoc = remoteView.state.doc;
        const jobs: Promise<void>[] = [];
        for (const hunk of hunks) {
            if (hunk.kind !== 'Conflict') continue;
            const count = hunk.local_end_line - hunk.local_start_line;
            // Per spec: only line-paired regions get word diff; hunks whose sides
            // have different line counts fall back to line-level highlighting.
            if (
                count === 0 ||
                count !== hunk.remote_end_line - hunk.remote_start_line
            )
                continue;
            for (let k = 0; k < count; k++) {
                const localLineNo = hunk.local_start_line + k + 1;
                const remoteLineNo = hunk.remote_start_line + k + 1;
                if (
                    localLineNo > localDoc.lines ||
                    remoteLineNo > remoteDoc.lines
                )
                    continue;
                const localLine = localDoc.line(localLineNo);
                const remoteLine = remoteDoc.line(remoteLineNo);
                if (localLine.text === remoteLine.text) continue;
                jobs.push(
                    compute(localLine.text, remoteLine.text).then((ops) => {
                        const ranges = wordDiffRanges(
                            ops,
                            localLine.from,
                            remoteLine.from,
                        );
                        wordMarks.local.push(...ranges.old);
                        wordMarks.remote.push(...ranges.new);
                    }),
                );
            }
        }
        const results = await Promise.allSettled(jobs);
        const failed = results.filter((r) => r.status === 'rejected');
        if (failed.length)
            console.warn(
                `word diff failed for ${failed.length} line(s)`,
                (failed[0] as PromiseRejectedResult).reason,
            );
        if (!destroyed && jobs.length) pushSideDecorations();
    }

    // --- Syntax highlighting ------------------------------------------------
    async function loadLanguage() {
        const hint = input.languageHint;
        if (!hint) return;
        const description =
            LanguageDescription.matchFilename(languages, `file.${hint}`) ??
            LanguageDescription.matchLanguageName(languages, hint, true);
        if (!description) return;
        try {
            const support = await description.load();
            if (destroyed) return;
            for (const view of [localView, resultView, remoteView]) {
                view.dispatch({ effects: language.reconfigure(support) });
            }
        } catch (err) {
            console.warn(
                `could not load syntax highlighting for .${hint}`,
                err,
            );
        }
    }

    // --- Scroll sync (whichever pane the user scrolls drives the other two) -
    /**
     * Keeps all three panes locked together regardless of which one actually
     * moved — a scrollbar drag, keyboard paging, or any other input can
     * scroll a SIDE pane on its own (not just wheel-over-side, which already
     * redirects into the result pane before this ever runs), and nothing
     * used to bring the other two along, so they'd drift apart permanently.
     *
     * Reuses `computeConnectorGeometry`'s per-hunk spans (the exact same
     * geometry the connectors are drawn from, so "in sync" means the same
     * thing here as it does on screen): finds the last hunk whose span in
     * `source`'s own viewport has scrolled past the viewport's top edge
     * (span.top <= 0), takes the fractional position of that edge within the
     * hunk's span, then applies that same fraction to the hunk's span in
     * each OTHER pane. Re-anchors on every call instead of accumulating
     * drift, so it stays visually locked even when wrapped-line heights
     * differ between panes (a fixed line-index mapping would not).
     */
    // Set right before this function assigns `scrollTop` on a view other
    // than its own source, so that view's own native 'scroll' listener
    // (fired asynchronously by the browser as a consequence of that
    // assignment, not re-entrantly within this call) can recognize that
    // echo and consume it without calling back into `syncFrom` — otherwise
    // every synced pane re-triggers a full resync for a position that's
    // already correct, and under a fast/continuous real scroll that
    // redundant cascade compounds every tick, which was enough to back up
    // the main thread and produce the "ribbon lags behind the scroll"
    // symptom. Per-view (not a single blanket flag) because a blanket flag
    // held across the echo also swallows the NEXT genuine same-source
    // event if it lands inside that same window, which silently drops a
    // real scroll update instead of just an echo.
    const suppressNextScroll: Record<'local' | 'result' | 'remote', boolean> = {
        local: false,
        result: false,
        remote: false,
    };
    function syncFrom(source: 'local' | 'result' | 'remote') {
        const sourceView =
            source === 'local'
                ? localView
                : source === 'result'
                  ? resultView
                  : remoteView;
        const scrollTop = sourceView.scrollDOM.scrollTop;
        const geometry = computeConnectorGeometry(
            hunks,
            conflictModel,
            hunkIsCovering,
            localView,
            resultView,
            remoteView,
        );
        let chosen: ConnectorGeometry | null = null;
        for (const g of geometry) {
            if (g[source].top <= 0) chosen = g;
            else break;
        }
        for (const other of ['local', 'result', 'remote'] as const) {
            if (other === source) continue;
            const otherView =
                other === 'local'
                    ? localView
                    : other === 'result'
                      ? resultView
                      : remoteView;
            let nextScrollTop: number;
            if (!chosen) {
                nextScrollTop = scrollTop;
            } else {
                const sourceSpan = chosen[source];
                const sourceHeight = Math.max(
                    sourceSpan.bottom - sourceSpan.top,
                    1,
                );
                const fraction = Math.min(
                    Math.max(-sourceSpan.top / sourceHeight, 0),
                    1,
                );
                // Past the last matched hunk's bottom edge, there's no
                // further geometry to anchor to (trailing unchanged
                // content) — carry the extra scroll distance over 1:1
                // instead of letting the fraction clamp silently drop it.
                const overshoot = Math.max(-sourceSpan.bottom, 0);
                const otherSpan = chosen[other];
                const otherDocTop =
                    otherSpan.top + otherView.scrollDOM.scrollTop;
                const otherHeight = Math.max(
                    otherSpan.bottom - otherSpan.top,
                    1,
                );
                nextScrollTop =
                    otherDocTop + fraction * otherHeight + overshoot;
            }
            // A no-op assignment (already at this scrollTop — the common
            // case once things have converged) doesn't fire a native
            // 'scroll' event at all, so only arm the suppression when the
            // value is actually changing and an echo is actually coming.
            if (otherView.scrollDOM.scrollTop !== nextScrollTop) {
                suppressNextScroll[other] = true;
                otherView.scrollDOM.scrollTop = nextScrollTop;
            }
        }
        scheduleConnectorRender();
    }
    const onResultScroll = () => {
        if (suppressNextScroll.result) {
            suppressNextScroll.result = false;
            return;
        }
        syncFrom('result');
    };
    resultView.scrollDOM.addEventListener('scroll', onResultScroll, {
        passive: true,
    });
    // A side pane can scroll on its own without going through `onSideWheel`
    // (scrollbar-thumb drag, keyboard paging/Home/End, touch or trackpad
    // input that a platform delivers as a native `scroll` with no matching
    // `wheel` event) — `syncFrom` brings the other two panes (and the
    // connectors) along regardless.
    const onLocalScroll = () => {
        if (suppressNextScroll.local) {
            suppressNextScroll.local = false;
            return;
        }
        syncFrom('local');
    };
    const onRemoteScroll = () => {
        if (suppressNextScroll.remote) {
            suppressNextScroll.remote = false;
            return;
        }
        syncFrom('remote');
    };
    localView.scrollDOM.addEventListener('scroll', onLocalScroll, {
        passive: true,
    });
    remoteView.scrollDOM.addEventListener('scroll', onRemoteScroll, {
        passive: true,
    });
    // Vertical wheel over a side pane scrolls the result instead, which then
    // drives both sides — keeps all three panes locked together. Synced
    // immediately in the same handler (not left to the async `scroll` event
    // alone) so there's no one-frame lag between the wheel input and the
    // other two panes catching up. Arms the same echo-suppression as
    // `syncFrom` itself, since this assignment fires RESULT's own native
    // 'scroll' event too, and the explicit `syncFrom('result')` right after
    // already handles this tick.
    const onSideWheel = (event: WheelEvent) => {
        if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
        event.preventDefault();
        suppressNextScroll.result = true;
        resultView.scrollDOM.scrollTop += event.deltaY;
        syncFrom('result');
    };
    localView.scrollDOM.addEventListener('wheel', onSideWheel, {
        passive: false,
    });
    remoteView.scrollDOM.addEventListener('wheel', onSideWheel, {
        passive: false,
    });
    // A pane resize (divider drag, double-click reset, or window resize)
    // changes the dividers' pixel height/width; snap connectors to it
    // immediately rather than waiting for the next scroll/edit.
    const connectorResizeObserver =
        typeof ResizeObserver !== 'undefined'
            ? new ResizeObserver(() => scheduleConnectorRender())
            : null;
    connectorResizeObserver?.observe(panes);
    // Fallback for embedded webviews without ResizeObserver, and for window
    // size changes that don't change `panes` itself: still cheap and
    // RAF-coalesced, so it costs nothing to keep as a second safety net.
    const onWindowResize = () => scheduleConnectorRender();
    window.addEventListener('resize', onWindowResize);

    // --- Header ---------------------------------------------------------------
    function updateHeader() {
        const unresolved = conflictModel.unresolvedCount();
        unresolvedPill.textContent =
            unresolved === 0 ? 'all resolved' : `${unresolved} unresolved`;
        unresolvedPill.classList.toggle(
            'tw-unresolved-pill-done',
            unresolved === 0,
        );
    }

    // --- Public API -----------------------------------------------------------
    function pullText(
        hunkIndex: number,
        text: string,
        userEvent: string,
    ): boolean {
        if (destroyed || hunkIndex < 0 || hunkIndex >= hunks.length)
            return false;
        const range = conflictModel.rangeFor(hunkIndex);
        const covering = hunkIsCovering(hunkIndex);
        const pull = computePullChange(
            resultView.state.doc,
            range,
            text,
            covering,
        );
        const prev: HunkSnapshot = {
            range,
            resolved: conflictModel.isResolved(hunkIndex),
            coversLines: coversLines[hunkIndex],
        };
        const next: HunkStateChange = pull
            ? {
                  index: hunkIndex,
                  range: pull.range,
                  resolved: true,
                  coversLines: pull.coversLines,
                  prev,
              }
            : {
                  index: hunkIndex,
                  range,
                  resolved: true,
                  coversLines: coversLines[hunkIndex],
                  prev,
              };
        if (!pull && prev.resolved) return false;
        resultView.dispatch({
            changes: pull ? pull.change : undefined,
            effects: hunkStateEffect.of(next),
            userEvent,
        });
        return true;
    }

    /** Always a plain replace — see `acceptSide` below for the stacking variant. */
    function pullHunk(hunkIndex: number, side: Side): boolean {
        return pullText(
            hunkIndex,
            sideText(hunkIndex, side),
            `input.pull.${side}`,
        );
    }

    /**
     * PhpStorm-style "accept this side": like `pullHunk`, but if the OTHER
     * side is already cleanly in place (the hunk's live range holds exactly
     * that side's text, not something hand-edited away from it) this
     * appends `side` after it instead of replacing it — so accepting one
     * side then the other (in either order) keeps both, stacked in CLICK
     * ORDER: the side already in place stays on top, the side just accepted
     * goes below it. Falls back to a plain `pullHunk` replace whenever that
     * isn't representable — the first pull on a hunk, accepting the same
     * side again, or a result already hand-edited away from either side's
     * exact text — since stacking isn't always possible.
     */
    function acceptSide(hunkIndex: number, side: Side): boolean {
        const hunk = hunks[hunkIndex];
        // Only stack onto a hunk the user has already explicitly resolved —
        // an untouched Conflict starts seeded with local's text ("ours
        // first"), so checking content alone would wrongly treat accepting
        // remote on a still-open conflict as "local was already accepted".
        if (hunk.kind !== 'Conflict' || !conflictModel.isResolved(hunkIndex))
            return pullHunk(hunkIndex, side);
        const otherSide: Side = side === 'local' ? 'remote' : 'local';
        const range = conflictModel.rangeFor(hunkIndex);
        // ConflictModel's tracked range excludes the hunk's own trailing
        // line break (see `computePullChange`'s doc comment), but `*_text`
        // ends with one — strip it before comparing, same as
        // `computePullChange`'s `sideBody`, or this would never match.
        const otherText = sideText(hunkIndex, otherSide);
        const otherBody = otherText.endsWith('\n')
            ? otherText.slice(0, -1)
            : otherText;
        const stacking =
            resultView.state.sliceDoc(range.from, range.to) === otherBody;
        if (!stacking) return pullHunk(hunkIndex, side);
        // `otherSide` is already in place (it's what made `stacking` true
        // above), so it stays on top; `side`, just accepted now, goes below.
        return pullText(
            hunkIndex,
            otherText + sideText(hunkIndex, side),
            `input.pull.${side}`,
        );
    }

    /**
     * "Accept both" semantics (not speced by Task 7/10's hunk model, which
     * only has per-side text): replace the hunk's live range with LOCAL's
     * lines followed by REMOTE's lines, in that order. Local-then-remote
     * mirrors the ordering already used everywhere else in this view (local
     * pane left of remote pane, `<` before `>` pull arrows, conflict-marker
     * convention of `<<<<<<< local` before `>>>>>>> remote`), so the result
     * reads the same way a user would read the two panes left to right. Both
     * `local_text`/`remote_text` already end with their own line break (see
     * `bindings.ts`), so straight concatenation produces well-formed lines
     * with no manual separator needed; `computePullChange` handles the
     * covering/zero-width and trailing-newline bookkeeping identically to a
     * single-side pull.
     */
    function pullBoth(hunkIndex: number): boolean {
        if (hunkIndex < 0 || hunkIndex >= hunks.length) return false;
        const hunk = hunks[hunkIndex];
        return pullText(
            hunkIndex,
            hunk.local_text + hunk.remote_text,
            'input.pull.both',
        );
    }

    /**
     * Resolves every still-unresolved whitespace-only conflict (see
     * `isWhitespaceOnlyConflict`) by pulling local's text into it — local
     * vs. remote is immaterial here since the two already agree modulo
     * whitespace. Dispatches one transaction per resolved hunk via the
     * existing `pullHunk`, rather than batching them into a single
     * transaction: `pullHunk` always reads the hunk's current (possibly
     * already-remapped) range from `conflictModel`, so sequential dispatches
     * stay correctly positioned for free. The trade-off is one undo step per
     * hunk instead of one combined step, which matches how every other
     * multi-hunk action in this file that isn't a single whole-doc replace
     * already behaves.
     */
    function resolveSimpleConflicts(): number {
        let resolvedCount = 0;
        hunks.forEach((hunk, index) => {
            if (
                !conflictModel.isResolved(index) &&
                isWhitespaceOnlyConflict(hunk) &&
                pullHunk(index, 'local')
            )
                resolvedCount++;
        });
        return resolvedCount;
    }

    /**
     * Whole-file accept: replaces the result doc outright with `side`'s
     * full text and marks every hunk resolved in the same transaction. The
     * hunks' tracked ranges no longer correspond to anything meaningful
     * once the whole document has been replaced wholesale (unlike a
     * per-hunk pull), so they're all collapsed to a zero-width point —
     * harmless, since `buildResultDecorations` already skips any hunk whose
     * range falls outside the (now different-length) document, and the
     * caller saves and closes right after this, with no further per-hunk
     * interaction expected.
     */
    function acceptWholeSide(side: Side): void {
        const fullText = (
            side === 'local' ? localView : remoteView
        ).state.doc.toString();
        const effects = hunks.map((_, index) => {
            const prev: HunkSnapshot = {
                range: conflictModel.rangeFor(index),
                resolved: conflictModel.isResolved(index),
                coversLines: coversLines[index],
            };
            return hunkStateEffect.of({
                index,
                range: { from: 0, to: 0 },
                resolved: true,
                coversLines: false,
                prev,
            });
        });
        resultView.dispatch({
            changes: {
                from: 0,
                to: resultView.state.doc.length,
                insert: fullText,
            },
            effects,
            userEvent: `input.acceptWhole.${side}`,
        });
    }

    function focusHunk(hunkIndex: number) {
        if (hunkIndex < 0 || hunkIndex >= hunks.length) return;
        const { from } = conflictModel.rangeFor(hunkIndex);
        const pos = Math.min(from, resultView.state.doc.length);
        resultView.dispatch({
            selection: { anchor: pos },
            effects: EditorView.scrollIntoView(pos, { y: 'center' }),
        });
        resultView.focus();
    }

    updateHeader();
    rediff();
    void loadLanguage();
    void loadWordDiffs();
    options.onHistoryChange?.({
        canUndo: undoDepth(resultView.state) > 0,
        canRedo: redoDepth(resultView.state) > 0,
    });

    return {
        localView,
        resultView,
        remoteView,
        conflictModel,
        hunks,
        pullHunk,
        acceptSide,
        pullBoth,
        acceptWholeSide,
        resolveSimpleConflicts,
        hunkIndexAt: (pos) => hunkIndexForCursor(conflictModel, hunks, pos),
        focusHunk,
        setWordDiffEnabled(enabled: boolean) {
            wordDiffEnabled = enabled;
            pushSideDecorations();
        },
        liveChunks: (side) => chunks[side],
        flushPendingDiff() {
            if (frame === null) return;
            scheduler.cancel(frame);
            frame = null;
            rediff();
        },
        get recomputeCount() {
            return recomputeCount;
        },
        undo: () => cmUndo(resultView),
        redo: () => cmRedo(resultView),
        canUndo: () => undoDepth(resultView.state) > 0,
        canRedo: () => redoDepth(resultView.state) > 0,
        destroy() {
            if (destroyed) return;
            destroyed = true;
            if (frame !== null) scheduler.cancel(frame);
            frame = null;
            if (connectorFrame !== null) scheduler.cancel(connectorFrame);
            connectorFrame = null;
            connectorResizeObserver?.disconnect();
            window.removeEventListener('resize', onWindowResize);
            resultView.scrollDOM.removeEventListener('scroll', onResultScroll);
            localView.scrollDOM.removeEventListener('scroll', onLocalScroll);
            remoteView.scrollDOM.removeEventListener('scroll', onRemoteScroll);
            localView.scrollDOM.removeEventListener('wheel', onSideWheel);
            remoteView.scrollDOM.removeEventListener('wheel', onSideWheel);
            localView.destroy();
            resultView.destroy();
            remoteView.destroy();
            panes.remove();
            container.classList.remove('tw-root');
        },
    };
}

/** Standalone form of `ThreeWayView.pullHunk` (brief's interface). */
export function pullHunk(
    view: ThreeWayView,
    hunkIndex: number,
    side: Side,
): boolean {
    return view.pullHunk(hunkIndex, side);
}
