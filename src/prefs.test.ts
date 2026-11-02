import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { beforeEach, expect, test } from "vitest";
import { LogicalSize, PhysicalSize } from "@tauri-apps/api/dpi";
import { DEFAULT_PREFS, loadPrefs, sanitizePrefs, savePrefTheme, savePrefWindowSize, toLogicalWindowSize } from "./prefs";

beforeEach(() => {
	clearMocks();
});

test("sanitizePrefs falls back to defaults field-by-field for missing/invalid data", () => {
	expect(sanitizePrefs({})).toEqual(DEFAULT_PREFS);
	expect(sanitizePrefs({ theme: "neon", windowSize: { width: 800, height: 600 } })).toEqual({
		theme: "system",
		windowSize: { width: 800, height: 600 },
	});
	expect(sanitizePrefs({ theme: "dark", windowSize: "not-a-size" })).toEqual({
		theme: "dark",
		windowSize: null,
	});
	expect(sanitizePrefs({ theme: "dark", windowSize: { width: 800 } })).toEqual({
		theme: "dark",
		windowSize: null,
	});
});

test("sanitizePrefs accepts a well-formed stored value unchanged", () => {
	expect(sanitizePrefs({ theme: "light", windowSize: { width: 1024, height: 768 } })).toEqual({
		theme: "light",
		windowSize: { width: 1024, height: 768 },
	});
});

/**
 * Integration-ish test exercising `loadPrefs`/`savePrefTheme`/`savePrefWindowSize`
 * against `@tauri-apps/api/mocks`' IPC mock, at the same `invoke()` layer
 * `@tauri-apps/plugin-store`'s JS binding actually calls
 * (`plugin:store|load`, `plugin:store|get`, `plugin:store|set`) — see
 * `node_modules/@tauri-apps/plugin-store/dist-js/index.js`. This covers the
 * module's own logic (reading back what was written, sanitizing it) without
 * needing a real Tauri webview/filesystem; it does not cover the Rust-side
 * plugin registration in `src-tauri/src/lib.rs`, which needs a real app run
 * (see task report).
 */
test("loadPrefs reads back a previously-set theme/windowSize through the mocked store", async () => {
	const backing = new Map<string, unknown>();
	let nextRid = 1;
	const rids = new Map<number, string>();
	mockIPC((cmd, args) => {
		const a = args as Record<string, unknown>;
		switch (cmd) {
			case "plugin:store|load": {
				const rid = nextRid++;
				rids.set(rid, a.path as string);
				return rid;
			}
			case "plugin:store|set": {
				backing.set(a.key as string, a.value);
				return null;
			}
			case "plugin:store|get": {
				const value = backing.get(a.key as string);
				return [value ?? null, backing.has(a.key as string)];
			}
			default:
				return null;
		}
	});

	const { prefs, store } = await loadPrefs();
	expect(prefs).toEqual(DEFAULT_PREFS);

	await savePrefTheme(store, "dark");
	await savePrefWindowSize(store, { width: 900, height: 650 });

	const reloaded = await loadPrefs();
	expect(reloaded.prefs).toEqual({ theme: "dark", windowSize: { width: 900, height: 650 } });
});

test("loadPrefs rejects when there is no Tauri runtime to talk to (caller falls back to defaults)", async () => {
	mockIPC(() => {
		throw new Error("no runtime");
	});
	await expect(loadPrefs()).rejects.toBeTruthy();
});

test("toLogicalWindowSize converts onResized's physical size to the logical size restore uses", () => {
	expect(toLogicalWindowSize({ width: 1600, height: 1200 }, 2)).toEqual({ width: 800, height: 600 });
	expect(toLogicalWindowSize({ width: 1000, height: 700 }, 1)).toEqual({ width: 1000, height: 700 });
	expect(toLogicalWindowSize({ width: 1001, height: 751 }, 1.5)).toEqual({ width: 667, height: 501 });
	// A bogus scale factor never produces NaN/Infinity sizes.
	expect(toLogicalWindowSize({ width: 800, height: 600 }, 0)).toEqual({ width: 800, height: 600 });
	expect(toLogicalWindowSize({ width: 800, height: 600 }, Number.NaN)).toEqual({ width: 800, height: 600 });
});

test("save -> restore round-trips on a Retina (2x) display instead of doubling every relaunch", () => {
	const scale = 2;
	let physical = new PhysicalSize(1600, 1200); // what onResized reports for an 800x600 window
	for (let launch = 0; launch < 3; launch++) {
		const saved = toLogicalWindowSize(physical, scale); // watchWindowSize
		const restored = new LogicalSize(saved.width, saved.height); // restoreWindowSize
		physical = restored.toPhysical(scale);
	}
	expect({ width: physical.width, height: physical.height }).toEqual({ width: 1600, height: 1200 });
});
