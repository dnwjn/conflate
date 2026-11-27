import { indentUnit } from '@codemirror/language';
import type { Compartment } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { commands } from '../bindings';

/**
 * Guesses indent style/size from a document's own lines: the most common
 * leading-whitespace width between consecutive non-blank lines, with tabs
 * winning outright if any line starts with one (mixed tab/space files are
 * rare enough that "any tab seen" is a reasonable signal).
 */
export function detectIndent(
    text: string,
): { style: 'tab' | 'space'; size: number } | null {
    const lines = text.split('\n');
    const leading = (line: string) => /^[ \t]*/.exec(line)?.[0] ?? '';

    for (const line of lines) {
        if (leading(line).includes('\t')) return { style: 'tab', size: 1 };
    }

    const counts = new Map<number, number>();
    let prevIndent = 0;
    for (const line of lines) {
        if (line.trim() === '') continue;
        const indent = leading(line).length;
        if (indent > prevIndent) {
            const delta = indent - prevIndent;
            counts.set(delta, (counts.get(delta) ?? 0) + 1);
        }
        prevIndent = indent;
    }
    if (counts.size === 0) return null;

    let bestDelta = 2;
    let bestCount = -1;
    for (const [delta, count] of counts) {
        if (count > bestCount) {
            bestDelta = delta;
            bestCount = count;
        }
    }
    return { style: 'space', size: bestDelta };
}

/**
 * Resolves and applies the indent style/size for the merged file: an
 * `.editorconfig` match (via the `get_indent_config` Rust command) wins,
 * falling back to `detectIndent` over the result text, falling back to
 * CodeMirror's own default when neither yields anything.
 */
export async function loadIndentConfig(params: {
    fullPath: string;
    docTextForDetection: string;
    indent: Compartment;
    views: readonly EditorView[];
    isDestroyed: () => boolean;
}): Promise<void> {
    const { fullPath, docTextForDetection, indent, views, isDestroyed } =
        params;

    let style: 'tab' | 'space' | null = null;
    let size: number | null = null;

    try {
        const config = await commands.getIndentConfig(fullPath);
        if (config.indentStyle) style = config.indentStyle as 'tab' | 'space';
        if (config.indentSize) size = config.indentSize;
    } catch (err) {
        console.warn('could not read .editorconfig', err);
    }

    if (!style || !size) {
        const detected = detectIndent(docTextForDetection);
        if (detected) {
            style ??= detected.style;
            size ??= detected.size;
        }
    }
    if (!style && !size) return;

    const unit =
        style === 'tab' ? '\t' : ' '.repeat(size && size > 0 ? size : 2);
    if (isDestroyed()) return;
    for (const view of views) {
        view.dispatch({ effects: indent.reconfigure(indentUnit.of(unit)) });
    }
}
