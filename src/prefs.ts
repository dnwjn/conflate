/**
 * Persisted app preferences, via `tauri-plugin-store` (Rust-side plugin
 * registered in `src-tauri/src/lib.rs`, JS-side binding
 * `@tauri-apps/plugin-store`). Backs the manual theme override and the last
 * window size in a `prefs.json` under the app's config dir, loaded once at
 * startup (`main.ts`) before the UI renders.
 */

import { load, type Store } from "@tauri-apps/plugin-store";
import type { ThemeOverride } from "./theme";

/** Window inner size in LOGICAL pixels (what `LogicalSize`/`setSize` restore). */
export interface WindowSize {
	width: number;
	height: number;
}

export interface Prefs {
	theme: ThemeOverride;
	windowSize: WindowSize | null;
}

export const PREFS_FILE = "prefs.json";

export const DEFAULT_PREFS: Prefs = { theme: "system", windowSize: null };

function isThemeOverride(value: unknown): value is ThemeOverride {
	return value === "light" || value === "dark" || value === "system";
}

function isWindowSize(value: unknown): value is WindowSize {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as WindowSize).width === "number" &&
		typeof (value as WindowSize).height === "number" &&
		Number.isFinite((value as WindowSize).width) &&
		Number.isFinite((value as WindowSize).height)
	);
}

/**
 * Sanitizes whatever `prefs.json` actually contained against corruption, an
 * old format, or a key simply missing, falling back to defaults field by
 * field rather than trusting the file blindly or rejecting the whole thing.
 * Exported separately from `loadPrefs` so this logic is unit-testable
 * without a Tauri runtime.
 */
export function sanitizePrefs(raw: { theme?: unknown; windowSize?: unknown }): Prefs {
	return {
		theme: isThemeOverride(raw.theme) ? raw.theme : DEFAULT_PREFS.theme,
		windowSize: isWindowSize(raw.windowSize) ? raw.windowSize : DEFAULT_PREFS.windowSize,
	};
}

/**
 * Loads (creating if absent) `prefs.json` and returns both the sanitized
 * preferences and the open `Store` handle, so the caller can later persist
 * changes (theme override cycles, window resizes) through the same handle
 * without re-opening the file.
 */
export async function loadPrefs(): Promise<{ prefs: Prefs; store: Store }> {
	const store = await load(PREFS_FILE, { defaults: { ...DEFAULT_PREFS } });
	const theme = await store.get<ThemeOverride>("theme");
	const windowSize = await store.get<WindowSize>("windowSize");
	return { store, prefs: sanitizePrefs({ theme, windowSize }) };
}

export async function savePrefTheme(store: Store, theme: ThemeOverride): Promise<void> {
	await store.set("theme", theme);
}

/**
 * Converts a PHYSICAL size (what Tauri's `onResized` reports) to the LOGICAL
 * size that is persisted and later restored with `LogicalSize`. Persisting
 * the physical size made the window grow by the scale factor (2x on Retina)
 * on every relaunch. A bogus scale factor is treated as 1.
 */
export function toLogicalWindowSize(physical: WindowSize, scaleFactor: number): WindowSize {
	const scale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
	return { width: Math.round(physical.width / scale), height: Math.round(physical.height / scale) };
}

export async function savePrefWindowSize(store: Store, size: WindowSize): Promise<void> {
	await store.set("windowSize", size);
}
