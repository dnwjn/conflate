import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mountApp, windowTitleFor } from "./app";
import { makeHunk } from "./merge/testHunks";

const input = { base: "a\n", local: "L\n", remote: "R\n", languageHint: null, fileName: "pricing.rs" };
const mergeResult = {
	auto_merged_text: "L\n",
	conflict_count: 1,
	hunks: [
		makeHunk({
			start_line: 0,
			end_line: 1,
			kind: "Conflict",
			base_text: "a\n",
			local_text: "L\n",
			remote_text: "R\n",
			merged_text: "L\n",
		}),
	],
};

// jsdom has no layout: CodeMirror's scroll-into-view measurement (used when
// the app focuses the first conflict) calls Range#getClientRects, which
// jsdom doesn't implement. Stub it so measurement degrades to zero rects.
if (!Range.prototype.getClientRects) {
	Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
	Range.prototype.getBoundingClientRect = () => new DOMRect();
}

let root: HTMLElement;
beforeEach(() => {
	clearMocks();
	root = document.createElement("div");
	document.body.appendChild(root);
});
afterEach(() => {
	document.body.innerHTML = "";
});

function mockBackend(overrides: Record<string, (args: unknown) => unknown> = {}) {
	const calls: { cmd: string; args: unknown }[] = [];
	mockIPC((cmd, args) => {
		calls.push({ cmd, args });
		if (overrides[cmd]) return overrides[cmd](args);
		if (cmd === "get_merge_input") return input;
		if (cmd === "compute_three_way_merge_command") return mergeResult;
		if (cmd === "compute_word_diff_command") return [];
		return null;
	});
	return calls;
}

test("an internal-invariant rejection from compute_three_way_merge shows an error state, not a crash", async () => {
	mockBackend({ compute_three_way_merge_command: () => Promise.reject("invariant violated: hunks do not tile") });
	await expect(mountApp(root)).resolves.toBeUndefined();
	expect(root.querySelector(".error-state")?.textContent).toContain("invariant violated");
	expect(root.querySelector<HTMLButtonElement>("#save-button")!.disabled).toBe(true);
	expect(root.querySelector<HTMLButtonElement>("#abort-button")!.disabled).toBe(false);
	expect(root.querySelector(".tw-pane")).toBeNull();
});

test("a malformed merge result (hunk past end of doc) shows an error state instead of throwing", async () => {
	mockBackend({
		compute_three_way_merge_command: () => ({
			...mergeResult,
			hunks: [makeHunk({ start_line: 0, end_line: 9, kind: "Conflict" })],
		}),
	});
	await expect(mountApp(root)).resolves.toBeUndefined();
	expect(root.querySelector(".error-state")).not.toBeNull();
});

test("Save with unresolved conflicts asks first; cancel does not save, confirm saves with force", async () => {
	const calls = mockBackend();
	await mountApp(root);
	expect(root.querySelectorAll(".tw-pane")).toHaveLength(3);
	expect(root.querySelector("#app-message")?.textContent).toBe("1 conflict remaining");

	root.querySelector<HTMLButtonElement>("#save-button")!.click();
	await vi.waitFor(() => expect(root.querySelector(".modal-card")).not.toBeNull());
	root.querySelector<HTMLButtonElement>('[data-action="cancel"]')!.click();
	await Promise.resolve();
	expect(calls.some((c) => c.cmd === "save_result")).toBe(false);

	root.querySelector<HTMLButtonElement>("#save-button")!.click();
	await vi.waitFor(() => expect(root.querySelector(".modal-card")).not.toBeNull());
	root.querySelector<HTMLButtonElement>('[data-action="confirm"]')!.click();
	await vi.waitFor(() => expect(calls.some((c) => c.cmd === "save_result")).toBe(true));
	expect(calls.find((c) => c.cmd === "save_result")!.args).toEqual({ content: "L\n", unresolvedCount: 1, force: true });
});

test("Save with everything resolved saves without asking and without force", async () => {
	const calls = mockBackend();
	await mountApp(root);
	(root.querySelector(".cm-pull-remote") as HTMLElement).click();
	expect(root.querySelector("#app-message")?.textContent).toBe("All conflicts resolved");
	root.querySelector<HTMLButtonElement>("#save-button")!.click();
	await vi.waitFor(() => expect(calls.some((c) => c.cmd === "save_result")).toBe(true));
	expect(root.querySelector(".modal-card")).toBeNull();
	expect(calls.find((c) => c.cmd === "save_result")!.args).toEqual({ content: "R\n", unresolvedCount: 0, force: false });
});

test("a rejected save_result is reported in the status bar", async () => {
	mockBackend({ save_result: () => Promise.reject("cannot write merged file") });
	await mountApp(root);
	(root.querySelector(".cm-pull-local") as HTMLElement).click();
	root.querySelector<HTMLButtonElement>("#save-button")!.click();
	await vi.waitFor(() => expect(root.querySelector("#app-message")?.textContent).toContain("cannot write merged file"));
	expect(root.querySelector<HTMLButtonElement>("#save-button")!.disabled).toBe(false);
});

test("Abort asks for confirmation before calling abort_merge", async () => {
	const calls = mockBackend();
	await mountApp(root);
	root.querySelector<HTMLButtonElement>("#abort-button")!.click();
	await vi.waitFor(() => expect(root.querySelector(".modal-card")).not.toBeNull());
	expect(calls.some((c) => c.cmd === "abort_merge")).toBe(false);
	root.querySelector<HTMLButtonElement>('[data-action="confirm"]')!.click();
	await vi.waitFor(() => expect(calls.some((c) => c.cmd === "abort_merge")).toBe(true));
});

// Delete-vs-modify: local deleted "b", remote changed it to "B" -> a
// ZERO-WIDTH conflict (index 1) immediately followed by an Unchanged hunk
// (index 2) starting at the same result offset; plus a normal conflict
// (index 3). Pinned on the Rust side by
// `delete_vs_modify_fixture_has_zero_width_conflict_then_unchanged_at_same_line`.
const deleteVsModifyInput = {
	base: "a\nb\nc\nd\n",
	local: "a\nc\nD1\n",
	remote: "a\nB\nc\nD2\n",
	languageHint: null,
	fileName: "doc.txt",
};
const deleteVsModifyResult = {
	auto_merged_text: "a\nc\nD1\n",
	conflict_count: 2,
	hunks: [
		makeHunk({ start_line: 0, end_line: 1, kind: "Unchanged", local_text: "a\n", remote_text: "a\n", merged_text: "a\n" }),
		makeHunk({
			start_line: 1,
			end_line: 1,
			kind: "Conflict",
			local_start_line: 1,
			local_end_line: 1,
			remote_start_line: 1,
			remote_end_line: 2,
			base_text: "b\n",
			local_text: "",
			remote_text: "B\n",
		}),
		makeHunk({
			start_line: 1,
			end_line: 2,
			kind: "Unchanged",
			local_start_line: 1,
			local_end_line: 2,
			remote_start_line: 2,
			remote_end_line: 3,
			local_text: "c\n",
			remote_text: "c\n",
			merged_text: "c\n",
		}),
		makeHunk({
			start_line: 2,
			end_line: 3,
			kind: "Conflict",
			local_start_line: 2,
			local_end_line: 3,
			remote_start_line: 3,
			remote_end_line: 4,
			base_text: "d\n",
			local_text: "D1\n",
			remote_text: "D2\n",
			merged_text: "D1\n",
		}),
	],
};

function press(code: string) {
	window.dispatchEvent(new KeyboardEvent("keydown", { code, metaKey: true, altKey: true, cancelable: true }));
}

function resultText(): string {
	return root.querySelector(".tw-pane-result .cm-content")!.textContent ?? "";
}

test("keyboard accept targets a zero-width (delete-vs-modify) conflict the cursor sits on", async () => {
	mockBackend({
		get_merge_input: () => deleteVsModifyInput,
		compute_three_way_merge_command: () => deleteVsModifyResult,
	});
	await mountApp(root);
	// The app focuses the first conflict on load: the zero-width one.
	expect(root.querySelector(".conflict-counter")?.textContent).toBe("Conflict 1 of 2");
	press("ArrowRight"); // ⌥⌘→ accept remote
	expect(root.querySelector("#app-message")?.textContent).toBe("1 conflict remaining");
	expect(resultText()).toContain("B");
});

test("keyboard previous/next navigation does not get stuck on a zero-width conflict", async () => {
	mockBackend({
		get_merge_input: () => deleteVsModifyInput,
		compute_three_way_merge_command: () => deleteVsModifyResult,
	});
	await mountApp(root);
	const counter = () => root.querySelector(".conflict-counter")?.textContent;
	expect(counter()).toBe("Conflict 1 of 2");
	press("Period"); // ⌥⌘. next
	expect(counter()).toBe("Conflict 2 of 2");
	press("Comma"); // ⌥⌘, previous
	expect(counter()).toBe("Conflict 1 of 2");
	press("Comma"); // wraps around to the last conflict
	expect(counter()).toBe("Conflict 2 of 2");
});

test("the window title names the file being merged", async () => {
	mockBackend();
	const setWindowTitle = vi.fn();
	await mountApp(root, { setWindowTitle });
	expect(setWindowTitle).toHaveBeenCalledWith("pricing.rs — Conflate");
	expect(document.title).toBe("pricing.rs — Conflate");
});

test("a failing native setTitle does not break loading the merge", async () => {
	mockBackend();
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	await mountApp(root, { setWindowTitle: () => Promise.reject("no permission") });
	expect(root.querySelectorAll(".tw-pane")).toHaveLength(3);
	warn.mockRestore();
});

test("windowTitleFor falls back to the bare app name", () => {
	expect(windowTitleFor("")).toBe("Conflate");
	expect(windowTitleFor("a.rs")).toBe("a.rs — Conflate");
});
