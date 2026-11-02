/**
 * Theme resolution + application.
 *
 * The original Task 12 brief assumed CM6 theming via a `Compartment` swapping
 * `@uiw/codemirror-theme-github`'s `githubLight`/`githubDark` extensions.
 * Task 10 actually built syntax highlighting with `@lezer/highlight`'s
 * `classHighlighter` (CSS classes on tokens, not inline styles), with the
 * actual color values living as CSS custom properties in `styles.css`,
 * already split into a default (light) `:root` block and an
 * `@media (prefers-color-scheme: dark)` override. There is no CM6 theme
 * `Compartment` and no `@uiw/codemirror-theme-github` dependency — this
 * module does not introduce either. Its job is just:
 *
 *  - a pure override-vs-system resolution function (testable without a DOM
 *    or Tauri runtime at all)
 *  - applying/removing a `data-theme` attribute on `<html>` so
 *    `styles.css`'s restructured selectors (`:root[data-theme="dark"]`, and
 *    the system media query now guarded with `:not([data-theme])`) pick the
 *    right palette — see the "CSS override precedence" section of the task
 *    12 report for the full cascade argument
 *  - live-updating when either the OS appearance changes (Tauri's
 *    `tauri://theme-changed` window event, with `matchMedia`'s `change`
 *    event as a fallback/duplicate signal — belt & suspenders, see
 *    `initTheme`'s doc comment) or the manual override changes
 */

export type ThemeOverride = "light" | "dark" | "system";
export type EffectiveTheme = "light" | "dark";

/** Cycle order used by both the ⌥⌘T keybinding and the toolbar button. */
export function nextOverride(current: ThemeOverride): ThemeOverride {
	if (current === "system") return "light";
	if (current === "light") return "dark";
	return "system";
}

/**
 * Pure resolution: an explicit override always wins; "system" falls back to
 * the live system preference passed in by the caller.
 */
export function resolveEffectiveTheme(override: ThemeOverride, systemPrefersDark: boolean): EffectiveTheme {
	if (override === "system") return systemPrefersDark ? "dark" : "light";
	return override;
}

/**
 * The `data-theme` attribute value an override maps to: `null` means "remove
 * the attribute", which is what lets `styles.css`'s `@media
 * (prefers-color-scheme: dark)` block (guarded with `:not([data-theme])`)
 * keep driving the "system" state live, straight off the browser's own media
 * query — no JS polling needed for that case to stay correct after launch.
 */
export function themeAttributeFor(override: ThemeOverride): EffectiveTheme | null {
	return override === "system" ? null : override;
}

/** Applies `override` to `root`'s `data-theme` attribute (defaults to `<html>`). */
export function applyThemeOverride(override: ThemeOverride, root: HTMLElement = document.documentElement): void {
	const attr = themeAttributeFor(override);
	if (attr === null) root.removeAttribute("data-theme");
	else root.setAttribute("data-theme", attr);
}

/** Short icon for the toolbar button, reflecting the *effective* resolved theme. */
export function themeIndicatorIcon(override: ThemeOverride, systemPrefersDark: boolean): string {
	if (override === "system") return "◐";
	return resolveEffectiveTheme(override, systemPrefersDark) === "dark" ? "🌙" : "☀";
}

/** Accessible label describing the current override + its resolved effect. */
export function themeIndicatorLabel(override: ThemeOverride, systemPrefersDark: boolean): string {
	const effective = resolveEffectiveTheme(override, systemPrefersDark);
	if (override === "system") return `Theme: system (currently ${effective})`;
	return `Theme: ${override}`;
}

export interface ThemeController {
	getOverride(): ThemeOverride;
	/** Sets a new override, applies it to the DOM, and notifies `onOverrideChange`. */
	setOverride(override: ThemeOverride): void;
	/** Cycles system → light → dark → system; same underlying `setOverride` call as the keybinding and the toolbar button both use. */
	cycle(): void;
	/** Removes the matchMedia/Tauri listeners. */
	dispose(): void;
}

export interface InitThemeOptions {
	initialOverride: ThemeOverride;
	/** Called whenever the override changes, so callers can persist it (e.g. to `prefs.json`). */
	onOverrideChange?: (override: ThemeOverride) => void;
	/** Called after every (re-)render, with the resolved theme, e.g. to update a toolbar indicator. */
	onEffectiveChange?: (effective: EffectiveTheme, override: ThemeOverride) => void;
	root?: HTMLElement;
	mediaQueryList?: MediaQueryList;
}

/**
 * Wires up live theme resolution: applies `initialOverride` immediately,
 * then listens for OS appearance changes via both Tauri's native
 * `tauri://theme-changed` window event (confirmed current for
 * `@tauri-apps/api` 2.12.4 — `getCurrentWindow().onThemeChanged` subscribes
 * to exactly that event name, see `TauriEvent.WINDOW_THEME_CHANGED` in
 * `@tauri-apps/api/event`) and `matchMedia('(prefers-color-scheme: dark)')`'s
 * `change` event as a fallback, re-resolving and re-rendering whenever
 * either fires. Only `override === "system"` ever triggers a re-render from
 * these listeners — a manual override is never fought by a live OS change.
 *
 * The Tauri listener is attached best-effort via a dynamic import: outside a
 * real Tauri webview (unit tests, or a plain browser preview) `@tauri-apps/api`
 * resolves but the event simply never fires, which is harmless — the
 * `matchMedia` listener and the CSS media query already cover "system"
 * correctly on their own. This is also exactly why only the pure functions
 * above are unit-tested directly; the native event wiring itself needs a
 * real Tauri window to exercise (see task report).
 */
export function initTheme(options: InitThemeOptions): ThemeController {
	const root = options.root ?? document.documentElement;
	const mql =
		options.mediaQueryList ??
		(typeof window !== "undefined" && typeof window.matchMedia === "function"
			? window.matchMedia("(prefers-color-scheme: dark)")
			: undefined);

	let override = options.initialOverride;
	let disposed = false;
	let unlistenTauri: (() => void) | null = null;

	function systemPrefersDark(): boolean {
		return mql?.matches ?? false;
	}

	function render() {
		applyThemeOverride(override, root);
		options.onEffectiveChange?.(resolveEffectiveTheme(override, systemPrefersDark()), override);
	}

	render();

	const onSystemChange = () => {
		if (override === "system") render();
	};
	mql?.addEventListener?.("change", onSystemChange);

	void import("@tauri-apps/api/window")
		.then(({ getCurrentWindow }) => getCurrentWindow().onThemeChanged(() => onSystemChange()))
		.then((unlisten) => {
			if (disposed) unlisten();
			else unlistenTauri = unlisten;
		})
		.catch(() => {
			// No Tauri runtime available — matchMedia above already covers it.
		});

	const controller: ThemeController = {
		getOverride: () => override,
		setOverride(next: ThemeOverride) {
			override = next;
			render();
			options.onOverrideChange?.(override);
		},
		cycle() {
			controller.setOverride(nextOverride(override));
		},
		dispose() {
			disposed = true;
			mql?.removeEventListener?.("change", onSystemChange);
			unlistenTauri?.();
		},
	};
	return controller;
}
