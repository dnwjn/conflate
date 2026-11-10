import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import type { Compartment } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { Hunk, WordDiffOp } from '../bindings';
import { wordDiffRanges } from './wordDiff';

type WordMarkSide = 'local' | 'remote';

/**
 * Computes per-line word diffs (local vs. remote text) for every `Conflict`
 * hunk whose sides line up 1:1, pushing the resulting ranges into
 * `wordMarks` (mutated in place) and asking the caller to redraw once done.
 */
export async function loadWordDiffs(params: {
    computeWordDiff?: (
        oldText: string,
        newText: string,
    ) => Promise<WordDiffOp[]>;
    hunks: readonly Hunk[];
    localView: EditorView;
    remoteView: EditorView;
    wordMarks: Record<WordMarkSide, { from: number; to: number }[]>;
    isDestroyed: () => boolean;
    pushSideDecorations: () => void;
}): Promise<void> {
    const {
        computeWordDiff: compute,
        hunks,
        localView,
        remoteView,
        wordMarks,
        isDestroyed,
        pushSideDecorations,
    } = params;
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
            if (localLineNo > localDoc.lines || remoteLineNo > remoteDoc.lines)
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
    if (!isDestroyed() && jobs.length) pushSideDecorations();
}

/** Loads and applies syntax highlighting for `languageHint` across all three panes. */
export async function loadLanguage(params: {
    languageHint?: string | null;
    language: Compartment;
    views: readonly EditorView[];
    isDestroyed: () => boolean;
}): Promise<void> {
    const { languageHint: hint, language, views, isDestroyed } = params;
    if (!hint) return;
    const description =
        LanguageDescription.matchFilename(languages, `file.${hint}`) ??
        LanguageDescription.matchLanguageName(languages, hint, true);
    if (!description) return;
    try {
        const support = await description.load();
        if (isDestroyed()) return;
        for (const view of views) {
            view.dispatch({ effects: language.reconfigure(support) });
        }
    } catch (err) {
        console.warn(`could not load syntax highlighting for .${hint}`, err);
    }
}
