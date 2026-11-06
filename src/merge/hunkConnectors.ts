import type { EditorView } from '@codemirror/view';
import type { Hunk } from '../bindings';
import type { ConflictModel } from './conflictModel';

/** A vertical pixel range, relative to a pane's own scrolled viewport. `top === bottom` for a zero-width (gap) span. */
export interface Span {
    top: number;
    bottom: number;
}

export interface ConnectorGeometry {
    index: number;
    style: 'conflict' | 'auto';
    /**
     * Whether the LOCAL<->RESULT / RESULT<->REMOTE ribbon (respectively)
     * touches a zero-width endpoint (a side/result with nothing there).
     * Tracked per divider, not once for the whole hunk — a `LocalOnly`/
     * `RemoteOnly` hunk's two ribbons don't both touch the gap, only the
     * one on the side that has nothing. Drives a thicker connector stroke
     * on just that ribbon, to match the pane's own thicker `cm-hunk-gap`
     * line (deliberately bolder than an ordinary first/last boundary,
     * since a gap has no real line of its own to anchor to and would
     * otherwise be nearly invisible).
     */
    localHasGap: boolean;
    remoteHasGap: boolean;
    local: Span;
    result: Span;
    remote: Span;
}

/** 0-based, end-exclusive line range -> CM line numbers (1-based), clamped. Mirrors `threeWayView.ts`'s `linesOf`. */
function linesOf(
    doc: { lines: number },
    startLine: number,
    endLine: number,
): number[] {
    const out: number[] = [];
    for (let n = startLine + 1; n <= Math.min(endLine, doc.lines); n++)
        out.push(n);
    return out;
}

/** Line whose top edge marks a zero-width region at 0-based line `line`. Mirrors `threeWayView.ts`'s `gapLine`. */
function gapLine(
    doc: { lines: number },
    line: number,
): { number: number; atEnd: boolean } {
    return line < doc.lines
        ? { number: line + 1, atEnd: false }
        : { number: doc.lines, atEnd: true };
}

/**
 * Pixel span (viewport-relative, i.e. with the pane's own `scrollTop`
 * subtracted) covered by a side pane's `startLine..endLine` (0-based,
 * end-exclusive) hunk range.
 */
export function sideSpan(
    view: EditorView,
    startLine: number,
    endLine: number,
): Span {
    const doc = view.state.doc;
    const scrollTop = view.scrollDOM.scrollTop;
    const lines = linesOf(doc, startLine, endLine);
    if (lines.length === 0) {
        const gap = gapLine(doc, startLine);
        const block = view.lineBlockAt(doc.line(gap.number).from);
        const y =
            (gap.atEnd ? block.top + block.height : block.top) - scrollTop;
        return { top: y, bottom: y };
    }
    const first = view.lineBlockAt(doc.line(lines[0]).from);
    const last = view.lineBlockAt(doc.line(lines[lines.length - 1]).from);
    return {
        top: first.top - scrollTop,
        bottom: last.top + last.height - scrollTop,
    };
}

/**
 * Pixel span (viewport-relative) covered by a hunk's live result-pane range.
 * Mirrors `buildResultDecorations`'s covering/gap distinction so the
 * connector lines up exactly with the band it's annotating.
 */
export function resultSpan(
    view: EditorView,
    range: { from: number; to: number },
    covering: boolean,
): Span {
    const doc = view.state.doc;
    const scrollTop = view.scrollDOM.scrollTop;
    const from = Math.min(range.from, doc.length);
    const firstLine = doc.lineAt(from);
    if (covering) {
        const to = Math.min(range.to, doc.length);
        const lastLine = doc.lineAt(to);
        const first = view.lineBlockAt(firstLine.from);
        const last = view.lineBlockAt(lastLine.from);
        return {
            top: first.top - scrollTop,
            bottom: last.top + last.height - scrollTop,
        };
    }
    const atEnd = range.from === doc.length && firstLine.from !== range.from;
    const block = view.lineBlockAt(firstLine.from);
    const y = (atEnd ? block.top + block.height : block.top) - scrollTop;
    return { top: y, bottom: y };
}

/**
 * Per-hunk connector geometry for both dividers (LOCAL<->RESULT,
 * RESULT<->REMOTE). Skips `Unchanged` hunks, same as `buildResultDecorations`/
 * `pushSideDecorations` (there's nothing to connect for a hunk with no
 * difference on either side).
 */
export function computeConnectorGeometry(
    hunks: readonly Hunk[],
    conflictModel: ConflictModel,
    hunkIsCovering: (index: number) => boolean,
    localView: EditorView,
    resultView: EditorView,
    remoteView: EditorView,
): ConnectorGeometry[] {
    const out: ConnectorGeometry[] = [];
    for (let i = 0; i < hunks.length; i++) {
        const hunk = hunks[i];
        if (hunk.kind === 'Unchanged') continue;
        const resolved = conflictModel.isResolved(i);
        const style: ConnectorGeometry['style'] =
            hunk.kind === 'Conflict' && !resolved ? 'conflict' : 'auto';
        const local = sideSpan(
            localView,
            hunk.local_start_line,
            hunk.local_end_line,
        );
        const result = resultSpan(
            resultView,
            conflictModel.rangeFor(i),
            hunkIsCovering(i),
        );
        const remote = sideSpan(
            remoteView,
            hunk.remote_start_line,
            hunk.remote_end_line,
        );
        out.push({
            index: i,
            style,
            localHasGap:
                local.top === local.bottom || result.top === result.bottom,
            remoteHasGap:
                result.top === result.bottom || remote.top === remote.bottom,
            local,
            result,
            remote,
        });
    }
    return out;
}

/**
 * SVG path `d` for a ribbon connecting `left` (x=0) to `right` (x=width), as
 * a filled quadrilateral with cubic-bezier top/bottom edges (an S-curve
 * ribbon, matching the Beyond Compare/Meld look). Degenerates to a thin
 * sliver when either span is zero-height (a gap/pure-deletion hunk).
 */
/**
 * Insets a span by half of `strokeWidth` (the connector's stroke is
 * centered on the path — see `.tw-connector`/`.tw-connector-gap` in
 * styles.css) so the stroke's OUTER edge, not the path itself, lands
 * exactly on the span's true boundary. Without this, the visible (stroked)
 * top edge sits half the stroke width above the real boundary and the
 * bottom edge the same amount below it — a symmetric "too high and too
 * low" overshoot. Skipped for a zero-height (gap) span: insetting would
 * invert it (bottom < top).
 */
function insetForStroke(span: Span, strokeWidth: number): Span {
    if (span.top === span.bottom) return span;
    const strokeInset = strokeWidth / 2;
    return { top: span.top + strokeInset, bottom: span.bottom - strokeInset };
}

export function ribbonPath(
    width: number,
    left: Span,
    right: Span,
    strokeWidth = 1,
): string {
    const midX = width / 2;
    const l = insetForStroke(left, strokeWidth);
    const r = insetForStroke(right, strokeWidth);
    return [
        `M 0 ${l.top}`,
        `C ${midX} ${l.top} ${midX} ${r.top} ${width} ${r.top}`,
        `L ${width} ${r.bottom}`,
        `C ${midX} ${r.bottom} ${midX} ${l.bottom} 0 ${l.bottom}`,
        'Z',
    ].join(' ');
}
