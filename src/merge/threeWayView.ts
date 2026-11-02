import { history, historyKeymap, defaultKeymap, indentWithTab, invertedEffects } from "@codemirror/commands";
import { LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Chunk, type DiffConfig } from "@codemirror/merge";
import {
	type ChangeDesc,
	Compartment,
	type Extension,
	EditorState,
	type Range,
	StateEffect,
	StateField,
	type Text,
	type Transaction,
} from "@codemirror/state";
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
} from "@codemirror/view";
import { classHighlighter } from "@lezer/highlight";
import type { Hunk, MergeInputPayload, ThreeWayMergeResult, WordDiffOp } from "../bindings";
import { ConflictModel } from "./conflictModel";
import { hunkIndexAt as hunkIndexForCursor } from "./hunkNav";
import { computePullChange } from "./pullChange";
import { wordDiffRanges } from "./wordDiff";

export type Side = "local" | "remote";

/** Frame scheduler; injectable so tests can observe/flush coalescing. */
export interface FrameScheduler {
	request(callback: () => void): number;
	cancel(handle: number): void;
}

export interface ThreeWayViewOptions {
	/** Word-diff backend (the `compute_word_diff` IPC command in the app). Omit to disable word diff. */
	computeWordDiff?: (oldText: string, newText: string) => Promise<WordDiffOp[]>;
	/** Whether word-level highlights start enabled (default true). */
	wordDiff?: boolean;
	/** Called after every result-pane update (edit, selection move, resolution change). */
	onUpdate?: () => void;
	scheduler?: FrameScheduler;
	/** Labels shown after the pane names, e.g. "HEAD". */
	localLabel?: string;
	remoteLabel?: string;
}

export interface ThreeWayView {
	localView: EditorView;
	resultView: EditorView;
	remoteView: EditorView;
	conflictModel: ConflictModel;
	hunks: readonly Hunk[];
	/** Replaces the hunk's live result range with `side`'s text and marks it resolved. Returns false if nothing changed. */
	pullHunk(hunkIndex: number, side: Side): boolean;
	/**
	 * Replaces the hunk's live result range with BOTH sides' text (local's
	 * lines followed by remote's) and marks it resolved. See "Accept both"
	 * semantics in `keymap.ts` for why this order was chosen. Returns false
	 * if nothing changed.
	 */
	pullBoth(hunkIndex: number): boolean;
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

function mapRange(range: { from: number; to: number }, mapping: ChangeDesc): { from: number; to: number } {
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
				prev: { range: v.range, resolved: v.resolved, coversLines: v.coversLines },
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
		for (const e of tr.effects) if (e.is(setSideDecorations)) return e.value;
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
		const wrap = document.createElement("span");
		wrap.className = "cm-hunk-controls";
		wrap.setAttribute("aria-hidden", "false");
		if (this.canPullLocal) wrap.appendChild(this.button("local", "←", "Accept local for this hunk"));
		if (this.pill) {
			const pill = document.createElement("span");
			pill.className = `cm-hunk-pill cm-hunk-pill-${this.pill.replace(/\s+/g, "-")}`;
			pill.textContent = this.pill;
			wrap.appendChild(pill);
		}
		if (this.canPullRemote) wrap.appendChild(this.button("remote", "→", "Accept remote for this hunk"));
		return wrap;
	}

	private button(side: Side, glyph: string, title: string): HTMLElement {
		const button = document.createElement("button");
		button.type = "button";
		button.className = `cm-pull-arrow cm-pull-${side}`;
		button.textContent = glyph;
		button.title = title;
		button.setAttribute("aria-label", title);
		// Keep editor focus/selection untouched by the click.
		button.addEventListener("mousedown", (event) => event.preventDefault());
		button.addEventListener("click", (event) => {
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
	"&": { height: "100%" },
	".cm-scroller": { overflow: "auto", position: "relative" },
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
export const LINE_SEPARATOR: Extension = EditorState.lineSeparator.of("\n");

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
	if (typeof requestAnimationFrame === "function") {
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
	for (let n = startLine + 1; n <= Math.min(endLine, doc.lines); n++) out.push(n);
	return out;
}

/** Line whose top edge marks a zero-width region at 0-based line `line`. */
function gapLine(doc: Text, line: number): { number: number; atEnd: boolean } {
	return line < doc.lines ? { number: line + 1, atEnd: false } : { number: doc.lines, atEnd: true };
}

const AUTO_KINDS = new Set(["LocalOnly", "RemoteOnly", "SameChange"]);

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
	container.classList.add("tw-root");
	const panes = document.createElement("div");
	panes.className = "tw-panes";
	const makePane = (kind: "local" | "result" | "remote", label: string, sub: string) => {
		const pane = document.createElement("section");
		pane.className = `tw-pane tw-pane-${kind}`;
		const header = document.createElement("header");
		header.className = "tw-pane-header";
		const dot = document.createElement("span");
		dot.className = "tw-dot";
		const name = document.createElement("span");
		name.className = "tw-pane-label";
		name.textContent = label;
		const subLabel = document.createElement("span");
		subLabel.className = "tw-pane-sub";
		subLabel.textContent = sub ? `· ${sub}` : "";
		header.append(dot, name, subLabel);
		const editor = document.createElement("div");
		editor.className = "tw-editor";
		pane.append(header, editor);
		panes.appendChild(pane);
		return { header, editor };
	};
	const localPane = makePane("local", "LOCAL", options.localLabel ?? "HEAD");
	const resultPane = makePane("result", "RESULT", "editable");
	const remotePane = makePane("remote", "REMOTE", options.remoteLabel ?? "");
	const unresolvedPill = document.createElement("span");
	unresolvedPill.className = "tw-unresolved-pill";
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
		state: EditorState.create({ doc: input.local, extensions: sideExtensions }),
	});
	const remoteView = new EditorView({
		parent: remotePane.editor,
		state: EditorState.create({ doc: input.remote, extensions: sideExtensions }),
	});

	// --- Result pane --------------------------------------------------------
	const resultState0 = EditorState.create({ doc: mergeResult.auto_merged_text, extensions: LINE_SEPARATOR });
	const conflictModel = new ConflictModel(hunks, resultState0.doc);
	// Disambiguates zero-width vs one-empty-line ranges (see pullChange.ts).
	const coversLines = hunks.map((h) => h.end_line > h.start_line);

	let pendingChanges: ChangeDesc | null = null;
	let frame: number | null = null;
	let recomputeCount = 0;
	let chunksBuilt = false;
	const chunks: Record<Side, readonly Chunk[]> = { local: [], remote: [] };
	const wordMarks: Record<Side, { from: number; to: number }[]> = { local: [], remote: [] };

	const sideText = (index: number, side: Side) => (side === "local" ? hunks[index].local_text : hunks[index].remote_text);

	const hunkIsCovering = (index: number) => {
		const range = conflictModel.rangeFor(index);
		return coversLines[index] || range.from !== range.to;
	};

	function buildResultDecorations(view: EditorView): DecorationSet {
		const doc = view.state.doc;
		const decos: Range<Decoration>[] = [];
		for (let i = 0; i < hunks.length; i++) {
			const hunk = hunks[i];
			if (hunk.kind === "Unchanged") continue;
			const range = conflictModel.rangeFor(i);
			if (range.from > doc.length || range.to > doc.length) continue;
			const resolved = conflictModel.isResolved(i);
			const cls =
				hunk.kind === "Conflict" ? (resolved ? "cm-hunk-resolved" : "cm-hunk-conflict") : "cm-hunk-auto";
			const covering = hunkIsCovering(i);
			const firstLine = doc.lineAt(range.from);
			if (covering) {
				const lastLine = doc.lineAt(range.to);
				for (let n = firstLine.number; n <= lastLine.number; n++) {
					let lineCls = cls;
					if (n === firstLine.number) lineCls += " cm-hunk-first";
					if (n === lastLine.number) lineCls += " cm-hunk-last";
					decos.push(Decoration.line({ class: lineCls }).range(doc.line(n).from));
				}
			} else {
				const atEnd = range.from === doc.length && firstLine.from !== range.from;
				decos.push(
					Decoration.line({ class: `${cls} cm-hunk-gap${atEnd ? " cm-hunk-gap-end" : ""}` }).range(firstLine.from),
				);
			}
			// Arrows reflect the current state: shown only where pulling would
			// change the result — except on an unresolved conflict, where both
			// are always offered, since picking the side the result already
			// matches is itself the resolution.
			const open = hunk.kind === "Conflict" && !resolved;
			const canPullLocal = open || computePullChange(doc, range, hunk.local_text, covering) !== null;
			const canPullRemote = open || computePullChange(doc, range, hunk.remote_text, covering) !== null;
			const pill = AUTO_KINDS.has(hunk.kind) ? "auto-merged" : hunk.kind === "Conflict" && resolved ? "resolved" : null;
			if (canPullLocal || canPullRemote || pill) {
				decos.push(
					Decoration.widget({
						widget: new HunkControlsWidget(i, canPullLocal, canPullRemote, pill, (index, side) => {
							pullHunk(index, side);
						}),
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
					update.transactions.some((tr) =>
						tr.effects.some((e) => e.is(hunkStateEffect)),
					);
				if (relevant) this.decorations = buildResultDecorations(update.view);
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
				EditorView.clipboardInputFilter.of((text) => text.replace(/\r\n/g, "\n")),
				resultDecorations,
				EditorView.updateListener.of((update) => {
					if (update.docChanged || update.selectionSet || update.transactions.some((tr) => tr.effects.length)) {
						updateHeader();
						options.onUpdate?.();
					}
				}),
			],
		}),
		dispatchTransactions(trs: readonly Transaction[], view: EditorView) {
			let touched = false;
			for (const tr of trs) {
				if (tr.docChanged) {
					conflictModel.applyEdit(tr.changes);
					pendingChanges = pendingChanges ? pendingChanges.composeDesc(tr.changes.desc) : tr.changes.desc;
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
		for (const side of ["local", "remote"] as const) {
			const sideDoc = (side === "local" ? localView : remoteView).state.doc;
			if (!chunksBuilt) {
				chunks[side] = Chunk.build(sideDoc, resultDoc, DIFF_CONFIG);
			} else if (pendingChanges) {
				// Incremental: only the regions touched by the composed changes
				// since the last frame are re-diffed.
				chunks[side] = Chunk.updateB(chunks[side], sideDoc, resultDoc, pendingChanges, DIFF_CONFIG);
			}
			// else: only resolution state changed; chunks are still current.
		}
		chunksBuilt = true;
		pendingChanges = null;
		pushSideDecorations();
	}

	function pushSideDecorations() {
		for (const side of ["local", "remote"] as const) {
			const view = side === "local" ? localView : remoteView;
			const doc = view.state.doc;
			const decos: Range<Decoration>[] = [];
			const liveCls = `cm-live-diff cm-live-diff-${side}`;
			for (const chunk of chunks[side]) {
				if (chunk.fromA < chunk.toA) {
					const first = doc.lineAt(chunk.fromA).number;
					const last = doc.lineAt(chunk.endA).number;
					for (let n = first; n <= last; n++) decos.push(Decoration.line({ class: liveCls }).range(doc.line(n).from));
				} else {
					const pos = Math.min(chunk.fromA, doc.length);
					const line = doc.lineAt(pos);
					const atEnd = pos === doc.length && line.from !== pos;
					decos.push(
						Decoration.line({ class: `${liveCls} cm-live-gap${atEnd ? " cm-live-gap-end" : ""}` }).range(line.from),
					);
				}
			}
			for (let i = 0; i < hunks.length; i++) {
				const hunk = hunks[i];
				if (hunk.kind !== "Conflict") continue;
				const cls = conflictModel.isResolved(i) ? "cm-hunk-resolved" : "cm-hunk-conflict";
				const start = side === "local" ? hunk.local_start_line : hunk.remote_start_line;
				const end = side === "local" ? hunk.local_end_line : hunk.remote_end_line;
				const lines = linesOf(doc, start, end);
				if (lines.length) {
					lines.forEach((n, k) => {
						let lineCls = cls;
						if (k === 0) lineCls += " cm-hunk-first";
						if (k === lines.length - 1) lineCls += " cm-hunk-last";
						decos.push(Decoration.line({ class: lineCls }).range(doc.line(n).from));
					});
				} else {
					const gap = gapLine(doc, start);
					decos.push(
						Decoration.line({ class: `${cls} cm-hunk-gap${gap.atEnd ? " cm-hunk-gap-end" : ""}` }).range(
							doc.line(gap.number).from,
						),
					);
				}
			}
			if (wordDiffEnabled) {
				for (const mark of wordMarks[side]) {
					if (mark.to <= doc.length && mark.from < mark.to) {
						decos.push(Decoration.mark({ class: `cm-word-diff cm-word-${side}` }).range(mark.from, mark.to));
					}
				}
			}
			view.dispatch({ effects: setSideDecorations.of(Decoration.set(decos, true)) });
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
			if (hunk.kind !== "Conflict") continue;
			const count = hunk.local_end_line - hunk.local_start_line;
			// Per spec: only line-paired regions get word diff; hunks whose sides
			// have different line counts fall back to line-level highlighting.
			if (count === 0 || count !== hunk.remote_end_line - hunk.remote_start_line) continue;
			for (let k = 0; k < count; k++) {
				const localLineNo = hunk.local_start_line + k + 1;
				const remoteLineNo = hunk.remote_start_line + k + 1;
				if (localLineNo > localDoc.lines || remoteLineNo > remoteDoc.lines) continue;
				const localLine = localDoc.line(localLineNo);
				const remoteLine = remoteDoc.line(remoteLineNo);
				if (localLine.text === remoteLine.text) continue;
				jobs.push(
					compute(localLine.text, remoteLine.text).then((ops) => {
						const ranges = wordDiffRanges(ops, localLine.from, remoteLine.from);
						wordMarks.local.push(...ranges.old);
						wordMarks.remote.push(...ranges.new);
					}),
				);
			}
		}
		const results = await Promise.allSettled(jobs);
		const failed = results.filter((r) => r.status === "rejected");
		if (failed.length) console.warn(`word diff failed for ${failed.length} line(s)`, (failed[0] as PromiseRejectedResult).reason);
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
			console.warn(`could not load syntax highlighting for .${hint}`, err);
		}
	}

	// --- Scroll sync (result drives the sides) ------------------------------
	/**
	 * Last hunk starting at or before `pos` — i.e. the hunk whose LINES are
	 * shown there. Scroll sync needs exactly that (a zero-width conflict shows
	 * no lines, so aligning sides by it would be off by its other side's
	 * height); keyboard actions use `hunkIndexForCursor` instead.
	 */
	function hunkShownAt(pos: number): number {
		let found = -1;
		for (let i = 0; i < hunks.length; i++) {
			if (conflictModel.rangeFor(i).from <= pos) found = i;
			else break;
		}
		return found;
	}

	function syncScroll() {
		const scrollTop = resultView.scrollDOM.scrollTop;
		const block = resultView.lineBlockAtHeight(scrollTop);
		const offsetInto = scrollTop - block.top;
		const resultDoc = resultView.state.doc;
		const resultLine = resultDoc.lineAt(block.from).number - 1;
		const index = hunkShownAt(block.from);
		for (const side of ["local", "remote"] as const) {
			const view = side === "local" ? localView : remoteView;
			let sideLine = resultLine;
			if (index >= 0) {
				const hunk = hunks[index];
				const hunkStart = resultDoc.lineAt(conflictModel.rangeFor(index).from).number - 1;
				const start = side === "local" ? hunk.local_start_line : hunk.remote_start_line;
				const end = side === "local" ? hunk.local_end_line : hunk.remote_end_line;
				sideLine = start + Math.min(resultLine - hunkStart, Math.max(end - start - 1, 0));
			}
			const lineNo = Math.max(1, Math.min(sideLine + 1, view.state.doc.lines));
			const sideBlock = view.lineBlockAt(view.state.doc.line(lineNo).from);
			view.scrollDOM.scrollTop = sideBlock.top + offsetInto;
		}
	}
	const onResultScroll = () => syncScroll();
	resultView.scrollDOM.addEventListener("scroll", onResultScroll, { passive: true });
	// Vertical wheel over a side pane scrolls the result instead, which then
	// drives both sides — keeps all three panes locked together.
	const onSideWheel = (event: WheelEvent) => {
		if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
		event.preventDefault();
		resultView.scrollDOM.scrollTop += event.deltaY;
	};
	localView.scrollDOM.addEventListener("wheel", onSideWheel, { passive: false });
	remoteView.scrollDOM.addEventListener("wheel", onSideWheel, { passive: false });

	// --- Header ---------------------------------------------------------------
	function updateHeader() {
		const unresolved = conflictModel.unresolvedCount();
		unresolvedPill.textContent = unresolved === 0 ? "all resolved" : `${unresolved} unresolved`;
		unresolvedPill.classList.toggle("tw-unresolved-pill-done", unresolved === 0);
	}

	// --- Public API -----------------------------------------------------------
	function pullText(hunkIndex: number, text: string, userEvent: string): boolean {
		if (destroyed || hunkIndex < 0 || hunkIndex >= hunks.length) return false;
		const range = conflictModel.rangeFor(hunkIndex);
		const covering = hunkIsCovering(hunkIndex);
		const pull = computePullChange(resultView.state.doc, range, text, covering);
		const prev: HunkSnapshot = { range, resolved: conflictModel.isResolved(hunkIndex), coversLines: coversLines[hunkIndex] };
		const next: HunkStateChange = pull
			? { index: hunkIndex, range: pull.range, resolved: true, coversLines: pull.coversLines, prev }
			: { index: hunkIndex, range, resolved: true, coversLines: coversLines[hunkIndex], prev };
		if (!pull && prev.resolved) return false;
		resultView.dispatch({
			changes: pull ? pull.change : undefined,
			effects: hunkStateEffect.of(next),
			userEvent,
		});
		return true;
	}

	function pullHunk(hunkIndex: number, side: Side): boolean {
		return pullText(hunkIndex, sideText(hunkIndex, side), `input.pull.${side}`);
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
		return pullText(hunkIndex, hunk.local_text + hunk.remote_text, "input.pull.both");
	}

	function focusHunk(hunkIndex: number) {
		if (hunkIndex < 0 || hunkIndex >= hunks.length) return;
		const { from } = conflictModel.rangeFor(hunkIndex);
		const pos = Math.min(from, resultView.state.doc.length);
		resultView.dispatch({
			selection: { anchor: pos },
			effects: EditorView.scrollIntoView(pos, { y: "center" }),
		});
		resultView.focus();
	}

	updateHeader();
	rediff();
	void loadLanguage();
	void loadWordDiffs();

	return {
		localView,
		resultView,
		remoteView,
		conflictModel,
		hunks,
		pullHunk,
		pullBoth,
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
		destroy() {
			if (destroyed) return;
			destroyed = true;
			if (frame !== null) scheduler.cancel(frame);
			frame = null;
			resultView.scrollDOM.removeEventListener("scroll", onResultScroll);
			localView.scrollDOM.removeEventListener("wheel", onSideWheel);
			remoteView.scrollDOM.removeEventListener("wheel", onSideWheel);
			localView.destroy();
			resultView.destroy();
			remoteView.destroy();
			panes.remove();
			container.classList.remove("tw-root");
		},
	};
}

/** Standalone form of `ThreeWayView.pullHunk` (brief's interface). */
export function pullHunk(view: ThreeWayView, hunkIndex: number, side: Side): boolean {
	return view.pullHunk(hunkIndex, side);
}
