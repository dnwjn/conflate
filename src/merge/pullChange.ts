import type { Text } from '@codemirror/state';

export interface PullChange {
    /** The single CM6 change that performs the pull. */
    change: { from: number; to: number; insert: string };
    /**
     * The hunk's range in the document AFTER the change, in ConflictModel's
     * canonical form: `to` sits at the end of the hunk's last line (excluding
     * its line break), or `from === to` at a line start when the hunk now
     * covers no lines.
     */
    range: { from: number; to: number };
    /** Whether the hunk covers at least one line after the change. */
    coversLines: boolean;
}

/**
 * Computes the edit that replaces a hunk's live range in the result
 * document with one side's text for that hunk ("pull hunk").
 *
 * Why this isn't just `{from, to, insert: sideText}`: ConflictModel tracks
 * a hunk covering lines as `[start of first line, END of last line)` — the
 * last line break is NOT inside the range — while the side's hunk text
 * (`Hunk.local_text`/`remote_text`) DOES end with its line break. A zero-
 * width hunk is a bare point at a line start. So the pull has to translate
 * between "whole lines including terminators" and the tracked range:
 *
 * - covering range + non-empty side: replace the range with the side text
 *   minus its final line break (the document's existing break stays).
 * - covering range + empty side: delete the lines AND one line break, so no
 *   blank line is left behind.
 * - zero-width range + non-empty side: insert whole lines at the point.
 * - zero-width range + empty side: nothing to do.
 *
 * `coversLines` disambiguates `from === to`: a one-line hunk over an empty
 * line and a zero-width hunk are both `{from: p, to: p}` in ConflictModel.
 * The caller tracks it (initially `end_line > start_line`; after a pull,
 * the `coversLines` returned here).
 *
 * The returned `range` lets the caller restore canonical form: position
 * mapping alone would leave a filled-in zero-width hunk with its trailing
 * line break inside the range, breaking the next pull.
 *
 * Returns null when the pull would not change the document.
 */
export function computePullChange(
    doc: Text,
    range: { from: number; to: number },
    sideText: string,
    coversLines: boolean,
): PullChange | null {
    const docLength = doc.length;
    const sideBody = sideText.endsWith('\n') ? sideText.slice(0, -1) : sideText;
    const sideHasLines = sideText !== '';
    let { from, to } = range;

    let result: PullChange;
    if (coversLines || from !== to) {
        // A range that grew out of a zero-width point by the user typing whole
        // lines into it includes its own trailing line break; normalize to the
        // exclusive form first.
        if (!coversLines && doc.sliceString(to - 1, to) === '\n') to -= 1;
        const hasTerminator = to < docLength;
        if (!sideHasLines) {
            if (hasTerminator) {
                result = {
                    change: { from, to: to + 1, insert: '' },
                    range: { from, to: from },
                    coversLines: false,
                };
            } else if (from > 0) {
                result = {
                    change: { from: from - 1, to, insert: '' },
                    range: { from: from - 1, to: from - 1 },
                    coversLines: false,
                };
            } else {
                result = {
                    change: { from: 0, to, insert: '' },
                    range: { from: 0, to: 0 },
                    coversLines: false,
                };
            }
        } else {
            // At the very end of a document without a final newline there is no
            // terminator to reuse, so keep the side's own ending as-is.
            const insert = hasTerminator ? sideBody : sideText;
            result = {
                change: { from, to, insert },
                range: { from, to: from + sideBody.length },
                coversLines: true,
            };
        }
    } else {
        if (!sideHasLines) return null;
        const atLineStart =
            from === 0 || doc.sliceString(from - 1, from) === '\n';
        if (!atLineStart) {
            // End of a document whose last line has no line break: start a new
            // line, and keep the document's "no final newline" ending.
            result = {
                change: { from, to, insert: `\n${sideBody}` },
                range: { from: from + 1, to: from + 1 + sideBody.length },
                coversLines: true,
            };
        } else {
            const insert = from < docLength ? `${sideBody}\n` : sideText;
            result = {
                change: { from, to, insert },
                range: { from, to: from + sideBody.length },
                coversLines: true,
            };
        }
    }

    const { change } = result;
    if (change.insert === doc.sliceString(change.from, change.to)) return null;
    return result;
}
