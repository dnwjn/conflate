import { mountApp } from './app';
import {
    DEFAULT_PREFS,
    loadPrefs,
    type Prefs,
    savePrefPaneWidths,
    savePrefTheme,
    savePrefWindowSize,
    toLogicalWindowSize,
} from './prefs';
import { applyThemeOverride } from './theme';

/**
 * Loads persisted prefs (`prefs.json`, via `tauri-plugin-store`) before the
 * UI renders at all, so the correct theme attribute is on `<html>` before
 * the first paint (no light-then-dark flash) and the window can be resized
 * back to its last size before the merge view mounts.
 *
 * Falls back to defaults on any failure — e.g. running outside a real Tauri
 * webview (`vite` dev preview, or this file under a test runner) where the
 * store plugin's `invoke` has nothing to talk to. The app must still start
 * in that case; it just won't persist anything for the session.
 */
async function loadPrefsOrDefault(): Promise<{
    prefs: Prefs;
    store: Awaited<ReturnType<typeof loadPrefs>>['store'] | null;
}> {
    try {
        return await loadPrefs();
    } catch {
        return { prefs: DEFAULT_PREFS, store: null };
    }
}

async function restoreWindowSize(size: Prefs['windowSize']): Promise<void> {
    if (!size) return;
    try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const { LogicalSize } = await import('@tauri-apps/api/dpi');
        await getCurrentWindow().setSize(
            new LogicalSize(size.width, size.height),
        );
    } catch {
        // Not running in a Tauri webview (or the window command is unavailable) —
        // nothing to restore to.
    }
}

/**
 * Persists the window size on every resize, debounced so a drag doesn't
 * write to disk on every intermediate frame. Best-effort: if `store` is
 * `null` (prefs failed to load) or there's no Tauri window to listen on,
 * this silently does nothing.
 */
function watchWindowSize(
    store: Awaited<ReturnType<typeof loadPrefs>>['store'] | null,
): void {
    if (!store) return;
    void import('@tauri-apps/api/window')
        .then(async ({ getCurrentWindow }) => {
            const appWindow = getCurrentWindow();
            let timer: ReturnType<typeof setTimeout> | undefined;
            await appWindow.onResized(({ payload }) => {
                clearTimeout(timer);
                timer = setTimeout(() => {
                    // `payload` is PHYSICAL pixels; persist LOGICAL ones, which is what
                    // `restoreWindowSize` hands to `LogicalSize`. The scale factor is
                    // read at save time since the window may have changed displays.
                    void appWindow
                        .scaleFactor()
                        .then((scale) =>
                            savePrefWindowSize(
                                store,
                                toLogicalWindowSize(payload, scale),
                            ),
                        )
                        .catch(() => {
                            // Best-effort persistence.
                        });
                }, 300);
            });
        })
        .catch(() => {
            // No Tauri runtime — nothing to watch.
        });
}

window.addEventListener('DOMContentLoaded', () => {
    void (async () => {
        const root = document.querySelector<HTMLElement>('#app');
        if (!root) return;

        const { prefs, store } = await loadPrefsOrDefault();

        // Apply the resolved attribute before the first paint — avoids a
        // flash of the wrong palette while `mountApp`/`initTheme` spin up.
        applyThemeOverride(prefs.theme);

        await restoreWindowSize(prefs.windowSize);
        watchWindowSize(store);

        await mountApp(root, {
            initialTheme: prefs.theme,
            onThemeOverrideChange: (override) => {
                if (store) void savePrefTheme(store, override);
            },
            setWindowTitle: async (title) => {
                const { getCurrentWindow } = await import(
                    '@tauri-apps/api/window'
                );
                await getCurrentWindow().setTitle(title);
            },
            initialPaneWidths: prefs.paneWidths ?? undefined,
            onPaneWidthsChange: (widths) => {
                if (store) void savePrefPaneWidths(store, widths);
            },
        });
    })();
});
