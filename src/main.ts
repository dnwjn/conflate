import { type MountAppHandle, mountRoot, wireUpdateUi } from './app';
import {
    DEFAULT_PREFS,
    loadPrefs,
    type Prefs,
    savePrefPaneWidths,
    savePrefSkippedUpdateVersion,
    savePrefTheme,
    savePrefWindowSize,
    toLogicalWindowSize,
} from './prefs';
import { applyThemeOverride } from './theme';
import { checkForUpdate } from './update';

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

/**
 * Restores the persisted window size, re-centering afterwards since
 * `setSize` keeps the window's current top-left origin rather than growing
 * from its center. The window is created hidden (`visible: false` in
 * `tauri.conf.json`) specifically so this resize+recenter — and the
 * subsequent mount — happen off-screen; `showWindowOnceReady` reveals it
 * only once everything has settled, avoiding a visible jump/flash.
 */
async function restoreWindowSize(size: Prefs['windowSize']): Promise<void> {
    if (!size) return;
    try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const { LogicalSize } = await import('@tauri-apps/api/dpi');
        const appWindow = getCurrentWindow();
        await appWindow.setSize(new LogicalSize(size.width, size.height));
        await appWindow.center();
    } catch {
        // Not running in a Tauri webview (or the window command is unavailable) —
        // nothing to restore to.
    }
}

/** Reveals the window after it's been sized, positioned, and mounted. */
async function showWindowOnceReady(): Promise<void> {
    try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        await getCurrentWindow().show();
    } catch {
        // Not running in a Tauri webview — nothing to show.
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

/**
 * Checks for an update ~3s after the window loads, surfacing it only if one
 * was actually found, so a user isn't shown "you're up to date" noise on
 * every run. Never blocks or interrupts the merge flow: any failure (no
 * network, no Tauri runtime, manifest/auth failure) is swallowed by
 * `checkForUpdate` itself.
 *
 * Marks `app`'s version-button dot via `notifyUpdateFound` regardless of
 * how the user is actually told about it (here, the dismissible banner from
 * `wireUpdateUi`) — the dot reflects "an update exists", not "you clicked
 * the version number to check".
 */
function scheduleBackgroundUpdateCheck(
    root: HTMLElement,
    app: MountAppHandle,
    skippedVersion: Prefs['skippedUpdateVersion'],
    onSkipVersion: (version: string) => void,
): void {
    setTimeout(() => {
        void checkForUpdate().then((update) => {
            if (update) {
                app.notifyUpdateFound(update);
                wireUpdateUi(root, update, { skippedVersion, onSkipVersion });
            }
        });
    }, 3000);
}

window.addEventListener('DOMContentLoaded', () => {
    void (async () => {
        const root = document.querySelector<HTMLElement>('#app');
        if (!root) return;

        const { prefs, store } = await loadPrefsOrDefault();

        // Apply the resolved attribute before the first paint — avoids a
        // flash of the wrong palette while `mountApp`/`initTheme` spin up.
        applyThemeOverride(prefs.theme);

        let app: MountAppHandle;
        try {
            await restoreWindowSize(prefs.windowSize);
            watchWindowSize(store);

            app = await mountRoot(root, {
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
        } finally {
            // Reveal the window even if sizing or mounting failed above —
            // it was created hidden (`visible: false`) specifically to let
            // that setup happen off-screen, so it must never stay invisible.
            await showWindowOnceReady();
        }

        scheduleBackgroundUpdateCheck(
            root,
            app,
            prefs.skippedUpdateVersion,
            (version) => {
                if (store) void savePrefSkippedUpdateVersion(store, version);
            },
        );
    })();
});
