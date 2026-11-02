import type { WordDiffOp } from "../bindings";

export interface WordDiffRanges {
	/** Ranges of text only in the OLD string (from `Delete` ops), offset by `oldStart`. */
	old: { from: number; to: number }[];
	/** Ranges of text only in the NEW string (from `Insert` ops), offset by `newStart`. */
	new: { from: number; to: number }[];
}

/**
 * Converts a `compute_word_diff` op list into document ranges to highlight.
 *
 * Whitespace decision: an op whose text is ENTIRELY whitespace is not
 * highlighted (its length still advances the offsets, so later ranges stay
 * correct). The Rust word diff tokenizes whitespace runs as their own
 * tokens and doesn't fold whitespace-only changes into `Equal`, so a
 * re-indented or double-spaced line would otherwise show highlighted
 * "nothing" — invisible-glyph marks that pull the eye away from the
 * substantive word changes this layer exists to point at. The line-level
 * background highlight still shows that the line differs, so no information
 * is lost. Ops that mix words and whitespace (adjacent same-kind tokens are
 * coalesced by the backend, e.g. `"foo "`) are highlighted as-is.
 */
export function wordDiffRanges(ops: readonly WordDiffOp[], oldStart: number, newStart: number): WordDiffRanges {
	const ranges: WordDiffRanges = { old: [], new: [] };
	let oldPos = oldStart;
	let newPos = newStart;
	for (const op of ops) {
		const length = op.text.length;
		const highlight = op.text.trim() !== "";
		if (op.kind === "Equal") {
			oldPos += length;
			newPos += length;
		} else if (op.kind === "Delete") {
			if (highlight) ranges.old.push({ from: oldPos, to: oldPos + length });
			oldPos += length;
		} else {
			if (highlight) ranges.new.push({ from: newPos, to: newPos + length });
			newPos += length;
		}
	}
	return ranges;
}
