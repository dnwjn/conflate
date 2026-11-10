import redoIcon from './assets/icons/redo.svg?raw';
import undoIcon from './assets/icons/undo.svg?raw';
import wandIcon from './assets/icons/wand.svg?raw';
import type { MergeInputPayload, ThreeWayMergeResult } from './bindings';
import { buildBrandHeader, createUpdateChecker } from './brandHeader';
import {
    devStubMergeInput,
    devStubMergeResult,
    isTauriRuntime,
} from './devStub';
import {
    abortMerge,
    computeThreeWayMerge,
    computeWordDiff,
    getMergeInput,
    saveResult,
} from './ipc';
import { installKeymap } from './keymap';
import { isWhitespaceOnlyConflict } from './merge/conflictModel';
import { nextConflict, prevConflict } from './merge/hunkNav';
import {
    createThreeWayView,
    type Side,
    type ThreeWayView,
} from './merge/threeWayView';
import {
    button,
    confirmDialog,
    el,
    iconButton,
    showShortcutsHelp,
    showUpdateModal,
} from './modals';
import {
    initTheme,
    type ThemeController,
    type ThemeOverride,
    themeIndicatorIcon,
    themeIndicatorLabel,
} from './theme';
import type { UpdateInfo } from './update';

/**
 * Optional theming hook (Task 12). When omitted, the toolbar still renders
 * the theme-toggle button and ⌥⌘T still cycles an in-memory override — it
 * just isn't persisted or wired to live OS changes, which is enough to keep
 * `mountApp`'s existing tests (which don't care about theming) decoupled
 * from `initTheme`'s Tauri/matchMedia side effects.
 */
export interface MountAppOptions {
    initialTheme?: ThemeOverride;
    onThemeOverrideChange?: (override: ThemeOverride) => void;
    /**
     * Sets the NATIVE window title (Tauri's `setTitle`, wired in `main.ts`).
     * Injected rather than called directly so `mountApp`'s tests don't need
     * a Tauri window; `document.title` is always set regardless.
     */
    setWindowTitle?: (title: string) => void | Promise<void>;
    /** Persisted LOCAL/REMOTE pane widths to restore on mount. */
    initialPaneWidths?: { local: number; remote: number };
    /** Called once a divider drag ends, with the new LOCAL/REMOTE pane widths, so the caller can persist them. */
    onPaneWidthsChange?: (widths: { local: number; remote: number }) => void;
    /**
     * Merge input to use instead of calling `get_merge_input` — used by the
     * empty-state repo browser (`mountRoot`), which already loaded the
     * conflict straight from a repo's git index.
     */
    preloadedInput?: MergeInputPayload;
    /**
     * Overrides the default `save_result` IPC call. The repo-browser flow
     * passes one that writes to the repo's working-tree file and runs
     * `git add` instead, since there is no `git mergetool` `$MERGED` path in
     * that flow.
     */
    saveOverride?: (
        content: string,
        unresolvedCount: number,
        force: boolean,
    ) => Promise<void>;
    /**
     * Overrides the default `abort_merge` IPC call (which exits the whole
     * process). The repo-browser flow passes a no-op here: aborting just
     * means returning to the file list with nothing written.
     */
    abortOverride?: () => Promise<void>;
    /**
     * Called after a successful save or abort when an override is in use.
     * The default IPC paths exit the process, so this callback never fires
     * in a real `git mergetool` session — it exists for the repo-browser
     * flow, which uses it to return to the empty-state file list.
     */
    onSaveOrAbortComplete?: () => void;
}

/**
 * Window title for the file being merged, e.g. "pricing.rs — Conflate", so a
 * multi-file `git mergetool` run shows which file is open (per the design
 * reference's "filename in title bar").
 */
export function windowTitleFor(fileName: string): string {
    return fileName ? `${fileName} — Conflate` : 'Conflate';
}

/**
 * Mounts the merge UI: toolbar, 3-pane merge view (LOCAL | RESULT | REMOTE),
 * status bar with Abort / Save & Finish. Every IPC failure lands in a
 * visible error/status message rather than an unhandled rejection; the
 * Abort button stays usable in the error state so the user can always exit
 * the mergetool cleanly.
 */
/**
 * Returned by `mountApp` so a caller-driven update check (`main.ts`'s
 * silent background check, surfaced via `wireUpdateUi`'s banner) can keep
 * the toolbar's version-button dot in sync, exactly as an in-app
 * `onCheckForUpdates` click already does — regardless of *how* the user
 * was told about the update, the dot should show.
 */
export interface MountAppHandle {
    notifyUpdateFound(update: UpdateInfo): void;
}

export async function mountApp(
    root: HTMLElement,
    options: MountAppOptions = {},
): Promise<MountAppHandle> {
    root.innerHTML = '';
    root.classList.add('app');

    const { toolbar, versionButton } = buildBrandHeader();
    const prevButton = button('‹', 'toolbar-button', 'Previous conflict (⌥⌘,)');
    const nextButton = button('›', 'toolbar-button', 'Next conflict (⌥⌘.)');
    const counter = el('span', 'conflict-counter', '');
    const undoButton = iconButton(undoIcon, 'toolbar-button', 'Undo (⌘Z)');
    const redoButton = iconButton(redoIcon, 'toolbar-button', 'Redo (⇧⌘Z)');
    const resolveSimpleButton = iconButton(
        wandIcon,
        'toolbar-button',
        'Resolve simple conflicts (differ only in whitespace)',
    );
    resolveSimpleButton.id = 'resolve-simple-button';
    undoButton.disabled = true;
    redoButton.disabled = true;
    resolveSimpleButton.disabled = true;
    const wordDiffToggle = button(
        'Word diff',
        'toolbar-toggle is-on',
        'Toggle word-level highlighting (⌥⌘H)',
    );
    wordDiffToggle.setAttribute('aria-pressed', 'true');
    const themeButton = button('◐', 'toolbar-button', 'Toggle theme (⌥⌘T)');
    const shortcutsButton = button(
        '?',
        'toolbar-button',
        'Keyboard shortcuts (?)',
    );
    const filePathLabel = el('span', 'toolbar-filepath', '');
    toolbar.append(
        el('span', 'toolbar-divider'),
        filePathLabel,
        el('span', 'toolbar-divider'),
        prevButton,
        nextButton,
        counter,
        undoButton,
        redoButton,
        resolveSimpleButton,
        el('span', 'toolbar-spacer'),
        wordDiffToggle,
        themeButton,
        shortcutsButton,
    );

    // --- Theming (Task 12) ----------------------------------------------------
    // Applies immediately (before the merge input even loads) and keeps the
    // toolbar indicator in sync with live OS changes while the override is
    // "system". `cycleTheme` below is the single place both the keybinding and
    // the toolbar button call into, so they can never diverge.
    const theme: ThemeController = initTheme({
        initialOverride: options.initialTheme ?? 'system',
        onOverrideChange: options.onThemeOverrideChange,
        onEffectiveChange: (effective, override) => {
            themeButton.textContent = themeIndicatorIcon(
                override,
                effective === 'dark',
            );
            const label = `${themeIndicatorLabel(override, effective === 'dark')} — ⌥⌘T to cycle`;
            themeButton.title = label;
            themeButton.setAttribute('aria-label', label);
        },
    });
    function cycleTheme() {
        theme.cycle();
    }
    themeButton.addEventListener('click', cycleTheme);

    const devBanner = el(
        'div',
        'dev-banner',
        'Preview mode (no Tauri runtime) — showing stub data. Use `pnpm run tauri dev` or `pnpm run dev:stub` for a real merge.',
    );
    const body = el('main', 'merge-host');
    const statusBar = el('footer', 'statusbar');
    const statusText = el('span', 'status-text', 'Loading merge input...');
    statusText.id = 'app-message';
    const acceptLeftButton = button(
        'Accept left',
        'btn btn-secondary',
        'Replace the whole result with LOCAL, resolve everything, and save',
    );
    acceptLeftButton.id = 'accept-left-button';
    const acceptRightButton = button(
        'Accept right',
        'btn btn-secondary',
        'Replace the whole result with REMOTE, resolve everything, and save',
    );
    acceptRightButton.id = 'accept-right-button';
    const abortButton = button('Abort', 'btn btn-secondary');
    abortButton.id = 'abort-button';
    const saveButton = button('Save & Finish', 'btn btn-primary');
    saveButton.id = 'save-button';
    statusBar.append(
        acceptLeftButton,
        acceptRightButton,
        statusText,
        el('span', 'toolbar-spacer'),
        abortButton,
        saveButton,
    );
    root.append(toolbar);
    if (!isTauriRuntime()) root.append(devBanner);
    root.append(body, statusBar);

    setNavEnabled(false);
    saveButton.disabled = true;
    acceptLeftButton.disabled = true;
    acceptRightButton.disabled = true;

    let view: ThreeWayView | null = null;
    let busy = false;

    // Outside a real Tauri webview (e.g. `pnpm run dev` opened as a plain
    // browser tab) there's no backend to call and nothing to merge, so skip
    // straight to a stub merge for UI preview instead of surfacing the raw
    // "nothing to call invoke() on" failure.
    const devMode = !isTauriRuntime();

    const updateChecker = createUpdateChecker({
        versionButton,
        devMode,
        setStatus,
        onUpdateFound: (update) => showUpdateModal(root, update),
    });
    const handle: MountAppHandle = {
        notifyUpdateFound: updateChecker.notifyUpdateFound,
    };

    abortButton.addEventListener('click', () => void onAbort());
    saveButton.addEventListener('click', () => void onSave());
    acceptLeftButton.addEventListener(
        'click',
        () => void onAcceptWholeSide('local'),
    );
    acceptRightButton.addEventListener(
        'click',
        () => void onAcceptWholeSide('remote'),
    );

    // --- Load ---------------------------------------------------------------
    let input: MergeInputPayload;
    let mergeResult: ThreeWayMergeResult;
    if (devMode) {
        input = devStubMergeInput();
        mergeResult = devStubMergeResult(input);
    } else {
        if (options.preloadedInput) {
            input = options.preloadedInput;
        } else {
            try {
                input = await getMergeInput();
            } catch (err) {
                showError(`Failed to load merge input: ${String(err)}`);
                return handle;
            }
        }
        try {
            mergeResult = await computeThreeWayMerge(
                input.base ?? null,
                input.local,
                input.remote,
            );
        } catch (err) {
            // Internal-invariant violation in the Rust merge. Never shown a
            // partial/wrong merge; the user can only abort.
            showError(
                `Merge computation failed (internal error): ${String(err)}`,
            );
            return handle;
        }
    }
    const title = windowTitleFor(input.fileName);
    document.title = title;
    filePathLabel.textContent = input.fullPath;
    filePathLabel.title = input.fullPath;
    try {
        // Best-effort: a missing title must never block the merge itself.
        await options.setWindowTitle?.(title);
    } catch (err) {
        console.warn('could not set the window title', err);
    }
    try {
        view = createThreeWayView(body, input, mergeResult, {
            computeWordDiff: devMode ? undefined : computeWordDiff,
            onUpdate: refreshStatus,
            localLabel: input.localBranch ?? undefined,
            remoteLabel: input.remoteBranch ?? undefined,
            paneWidths: options.initialPaneWidths,
            onPaneWidthsChange: options.onPaneWidthsChange,
            onHistoryChange: ({ canUndo, canRedo }) => {
                undoButton.disabled = !canUndo;
                redoButton.disabled = !canRedo;
            },
        });
    } catch (err) {
        showError(`Could not display the merge: ${String(err)}`);
        return handle;
    }
    saveButton.disabled = false;
    acceptLeftButton.disabled = false;
    acceptRightButton.disabled = false;
    setNavEnabled(true);
    refreshStatus();
    const first = nextConflict(view.conflictModel, -1);
    if (first >= 0) view.focusHunk(first);

    prevButton.addEventListener('click', () => navigate(-1));
    nextButton.addEventListener('click', () => navigate(1));
    undoButton.addEventListener('click', () => view?.undo());
    redoButton.addEventListener('click', () => view?.redo());
    resolveSimpleButton.addEventListener('click', () => {
        if (!view || busy) return;
        view.resolveSimpleConflicts();
    });
    wordDiffToggle.addEventListener('click', () =>
        setWordDiffEnabled(!wordDiffToggle.classList.contains('is-on')),
    );
    shortcutsButton.addEventListener('click', () => showShortcutsHelp(root));
    // Not torn down: the app occupies its window for the whole merge-tool
    // process lifetime (same assumption the ad-hoc listener this replaces
    // made), so there is no unmount point to call the returned cleanup from.
    installKeymap({
        nextConflict: () => navigate(1),
        prevConflict: () => navigate(-1),
        acceptLocal: () => acceptSide('local'),
        acceptRemote: () => acceptSide('remote'),
        acceptBoth: () => acceptBoth(),
        save: () => void onSave(),
        abort: () => void onAbort(),
        undo: () => view?.undo(),
        redo: () => view?.redo(),
        toggleWordDiff: () =>
            setWordDiffEnabled(!wordDiffToggle.classList.contains('is-on')),
        toggleTheme: () => cycleTheme(),
        showHelp: () => showShortcutsHelp(root),
    });

    // --- Behaviour ------------------------------------------------------------
    function currentHunk(): number {
        if (!view) return -1;
        return view.hunkIndexAt(view.resultView.state.selection.main.head);
    }

    function navigate(direction: 1 | -1) {
        if (!view) return;
        const from = currentHunk();
        const target =
            direction === 1
                ? nextConflict(view.conflictModel, from)
                : prevConflict(view.conflictModel, from);
        if (target >= 0) view.focusHunk(target);
    }

    function setWordDiffEnabled(on: boolean) {
        wordDiffToggle.classList.toggle('is-on', on);
        wordDiffToggle.setAttribute('aria-pressed', String(on));
        view?.setWordDiffEnabled(on);
    }

    /** Accept `side` for the conflict the result cursor is currently inside. */
    function acceptSide(side: 'local' | 'remote') {
        if (!view) return;
        const index = currentHunk();
        if (index >= 0) view.acceptSide(index, side);
    }

    /** Accept both sides for the conflict the result cursor is currently inside. */
    function acceptBoth() {
        if (!view) return;
        const index = currentHunk();
        if (index >= 0) view.pullBoth(index);
    }

    function refreshStatus() {
        if (!view) return;
        const activeView = view;
        const conflicts = activeView.hunks.flatMap((h, i) =>
            h.kind === 'Conflict' ? [i] : [],
        );
        const unresolved = activeView.conflictModel.unresolvedCount();
        const position = conflicts.indexOf(currentHunk());
        counter.textContent =
            conflicts.length === 0
                ? 'No conflicts'
                : unresolved === 0
                  ? 'All resolved'
                  : `Conflict ${position >= 0 ? position + 1 : '–'} of ${conflicts.length}`;
        // Nothing left to jump between once every conflict is resolved —
        // leaving them enabled with nothing to do (prev/next find no
        // unresolved hunk to land on) reads as broken, not done.
        prevButton.disabled = unresolved === 0;
        nextButton.disabled = unresolved === 0;
        resolveSimpleButton.disabled = !activeView.hunks.some(
            (hunk, index) =>
                !activeView.conflictModel.isResolved(index) &&
                isWhitespaceOnlyConflict(hunk),
        );
        setStatus(
            unresolved === 0
                ? conflicts.length === 0
                    ? 'Everything merged automatically'
                    : 'All conflicts resolved'
                : `${unresolved} conflict${unresolved === 1 ? '' : 's'} remaining`,
            unresolved === 0 ? 'ok' : 'pending',
        );
    }

    /** Shared tail of `onSave`/`onAcceptWholeSide`: writes the result doc out and reports status. */
    async function performSave(force: boolean) {
        if (!view) return;
        busy = true;
        setButtonsDisabled(true);
        setStatus('Saving...', 'pending');
        try {
            const content = view.resultView.state.doc.toString();
            const unresolved = view.conflictModel.unresolvedCount();
            if (options.saveOverride) {
                await options.saveOverride(content, unresolved, force);
            } else {
                await saveResult(content, unresolved, force);
            }
            // On success the default (mergetool) path exits the process; if
            // we're still here, say so.
            setStatus('Saved.', 'ok');
            options.onSaveOrAbortComplete?.();
        } catch (err) {
            setStatus(`Save failed: ${String(err)}`, 'error');
        } finally {
            busy = false;
            setButtonsDisabled(false);
        }
    }

    async function onSave() {
        if (!view || busy) return;
        if (devMode) {
            setStatus(
                'Save is not available in preview mode (no Tauri runtime).',
                'error',
            );
            return;
        }
        const unresolved = view.conflictModel.unresolvedCount();
        let force = false;
        if (unresolved > 0) {
            const ok = await confirmDialog(root, {
                title: 'Save with unresolved conflicts?',
                body: `${unresolved} conflict${unresolved === 1 ? ' is' : 's are'} still unresolved. Their hunks will be saved as they currently appear in the result (local's version unless you edited them).`,
                confirmLabel: 'Save anyway',
            });
            if (!ok) return;
            // Matches save_result's contract: unresolved > 0 is refused unless forced.
            force = true;
        }
        await performSave(force);
    }

    /**
     * PhpStorm-style "Accept Left"/"Accept Right": an explicit, unambiguous
     * whole-file decision, so it skips `onSave`'s unresolved-conflicts
     * confirmation and saves immediately.
     */
    async function onAcceptWholeSide(side: Side) {
        if (!view || busy) return;
        if (devMode) {
            setStatus(
                'Accept is not available in preview mode (no Tauri runtime).',
                'error',
            );
            return;
        }
        view.acceptWholeSide(side);
        await performSave(true);
    }

    async function onAbort() {
        if (busy) return;
        if (devMode) {
            setStatus(
                'Abort is not available in preview mode (no Tauri runtime).',
                'error',
            );
            return;
        }
        const ok = await confirmDialog(root, {
            title: 'Abort this merge?',
            body: 'Nothing will be written. Git will treat the file as still conflicted.',
            confirmLabel: 'Abort merge',
            danger: true,
        });
        if (!ok) return;
        busy = true;
        setButtonsDisabled(true);
        try {
            if (options.abortOverride) {
                await options.abortOverride();
            } else {
                await abortMerge();
            }
            options.onSaveOrAbortComplete?.();
        } catch (err) {
            setStatus(`Abort failed: ${String(err)}`, 'error');
        } finally {
            busy = false;
            setButtonsDisabled(false);
        }
    }

    function showError(message: string) {
        body.innerHTML = '';
        const box = el('div', 'error-state');
        box.append(
            el('h2', 'error-title', "Can't show this merge"),
            el('p', 'error-body', message),
        );
        body.appendChild(box);
        setStatus(message, 'error');
        saveButton.disabled = true;
        acceptLeftButton.disabled = true;
        acceptRightButton.disabled = true;
        abortButton.disabled = false;
    }

    function setStatus(text: string, tone: 'ok' | 'pending' | 'error') {
        statusText.textContent = text;
        statusText.dataset.tone = tone;
    }

    function setNavEnabled(enabled: boolean) {
        prevButton.disabled = !enabled;
        nextButton.disabled = !enabled;
        wordDiffToggle.disabled = !enabled;
    }

    function setButtonsDisabled(disabled: boolean) {
        abortButton.disabled = disabled;
        saveButton.disabled = disabled || !view;
        acceptLeftButton.disabled = disabled || !view;
        acceptRightButton.disabled = disabled || !view;
    }

    return handle;
}

/**
 * Minimal in-page confirmation modal (resolves true on confirm, false on
 * cancel / Escape / backdrop click). Used instead of `window.confirm`,
 * whose support inside the Tauri 2 macOS webview is not guaranteed.
 *
 * `?`-triggered keyboard-shortcut help overlay, the non-modal update banner,
 * and the full update dialog all live alongside it in `./modals` (none of
 * them close over any `mountApp` state — each takes its target root and
 * whatever data it needs as explicit params).
 */
export {
    confirmDialog,
    showShortcutsHelp,
    showUpdateModal,
    wireUpdateUi,
} from './modals';
/**
 * Entry point `main.ts` calls instead of `mountApp` directly: decides
 * between the real merge view and the empty-state repo browser.
 *
 * - Not a Tauri runtime (dev preview) — today's `mountApp` stub path,
 *   unchanged.
 * - A Tauri runtime launched as `git mergetool` (`get_launch_mode` true) —
 *   today's `mountApp` merge path, unchanged.
 * - A Tauri runtime launched with no CLI args (`get_launch_mode` false) —
 *   the empty-state screen, with a repo browser that can open a conflicted
 *   file straight into the same merge view.
 */
export { mountRoot } from './rootRouter';
