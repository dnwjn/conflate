import packageJson from '../package.json';
import brandMarkIcon from './assets/icons/brand-mark.svg?raw';
import redoIcon from './assets/icons/redo.svg?raw';
import undoIcon from './assets/icons/undo.svg?raw';
import type { MergeInputPayload, ThreeWayMergeResult } from './bindings';
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
import { installKeymap, KEYMAP_BINDINGS } from './keymap';
import { nextConflict, prevConflict } from './merge/hunkNav';
import { createThreeWayView, type ThreeWayView } from './merge/threeWayView';
import {
    initTheme,
    type ThemeController,
    type ThemeOverride,
    themeIndicatorIcon,
    themeIndicatorLabel,
} from './theme';
import {
    checkForUpdate,
    downloadAndInstallUpdate,
    restartToApplyUpdate,
    type UpdateInfo,
} from './update';

/** Matches `endpoints`/the release page in `.github/workflows/release.yml` and `tauri.conf.json`. */
const RELEASES_URL = 'https://github.com/dnwjn/conflate/releases';

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

    const toolbar = el('header', 'toolbar');
    const brand = el('div', 'toolbar-brand');
    const versionButton = button(
        `v${packageJson.version}`,
        'brand-version',
        'Check for updates',
    );
    const brandMark = el('span', 'brand-mark');
    brandMark.innerHTML = brandMarkIcon;
    brand.append(
        brandMark,
        el('span', 'brand-name', 'Conflate'),
        versionButton,
    );
    const prevButton = button('‹', 'toolbar-button', 'Previous conflict (⌥⌘,)');
    const nextButton = button('›', 'toolbar-button', 'Next conflict (⌥⌘.)');
    const counter = el('span', 'conflict-counter', '');
    const undoButton = iconButton(undoIcon, 'toolbar-button', 'Undo (⌘Z)');
    const redoButton = iconButton(redoIcon, 'toolbar-button', 'Redo (⇧⌘Z)');
    undoButton.disabled = true;
    redoButton.disabled = true;
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
        brand,
        el('span', 'toolbar-divider'),
        filePathLabel,
        el('span', 'toolbar-divider'),
        prevButton,
        nextButton,
        counter,
        undoButton,
        redoButton,
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
        'Preview mode (no Tauri runtime) — showing stub data. Use `npm run tauri dev` or `npm run dev:stub` for a real merge.',
    );
    const body = el('main', 'merge-host');
    const statusBar = el('footer', 'statusbar');
    const statusText = el('span', 'status-text', 'Loading merge input...');
    statusText.id = 'app-message';
    const abortButton = button('Abort', 'btn btn-secondary');
    abortButton.id = 'abort-button';
    const saveButton = button('Save & Finish', 'btn btn-primary');
    saveButton.id = 'save-button';
    statusBar.append(
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

    let view: ThreeWayView | null = null;
    let busy = false;
    let foundUpdate: UpdateInfo | null = null;

    /** Marks an update as found regardless of which path discovered it (an in-app check or the background check that shows its own banner). */
    function notifyUpdateFound(update: UpdateInfo) {
        foundUpdate = update;
        versionButton.classList.add('has-update');
    }
    const handle: MountAppHandle = { notifyUpdateFound };

    abortButton.addEventListener('click', () => void onAbort());
    saveButton.addEventListener('click', () => void onSave());

    // --- Load ---------------------------------------------------------------
    // Outside a real Tauri webview (e.g. `npm run dev` opened as a plain
    // browser tab) there's no backend to call and nothing to merge, so skip
    // straight to a stub merge for UI preview instead of surfacing the raw
    // "nothing to call invoke() on" failure.
    const devMode = !isTauriRuntime();
    let input: MergeInputPayload;
    let mergeResult: ThreeWayMergeResult;
    if (devMode) {
        input = devStubMergeInput();
        mergeResult = devStubMergeResult(input);
    } else {
        try {
            input = await getMergeInput();
        } catch (err) {
            showError(`Failed to load merge input: ${String(err)}`);
            return handle;
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
    setNavEnabled(true);
    refreshStatus();
    const first = nextConflict(view.conflictModel, -1);
    if (first >= 0) view.focusHunk(first);

    prevButton.addEventListener('click', () => navigate(-1));
    nextButton.addEventListener('click', () => navigate(1));
    undoButton.addEventListener('click', () => view?.undo());
    redoButton.addEventListener('click', () => view?.redo());
    wordDiffToggle.addEventListener('click', () =>
        setWordDiffEnabled(!wordDiffToggle.classList.contains('is-on')),
    );
    shortcutsButton.addEventListener('click', () => showShortcutsHelp(root));
    versionButton.addEventListener('click', () => void onCheckForUpdates());
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
        const conflicts = view.hunks.flatMap((h, i) =>
            h.kind === 'Conflict' ? [i] : [],
        );
        const unresolved = view.conflictModel.unresolvedCount();
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
        setStatus(
            unresolved === 0
                ? conflicts.length === 0
                    ? 'Everything merged automatically'
                    : 'All conflicts resolved'
                : `${unresolved} conflict${unresolved === 1 ? '' : 's'} remaining`,
            unresolved === 0 ? 'ok' : 'pending',
        );
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
        busy = true;
        setButtonsDisabled(true);
        setStatus('Saving...', 'pending');
        try {
            await saveResult(
                view.resultView.state.doc.toString(),
                unresolved,
                force,
            );
            // On success the backend exits the process; if we're still here, say so.
            setStatus('Saved.', 'ok');
        } catch (err) {
            setStatus(`Save failed: ${String(err)}`, 'error');
        } finally {
            busy = false;
            setButtonsDisabled(false);
        }
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
            await abortMerge();
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
    }

    /**
     * An explicit, non-silent check: unlike `main.ts`'s background launch
     * check (which stays quiet unless it finds something), this always
     * says something, even "up to date". If this same `mountApp` instance
     * already found an update via an earlier click, reopen it instead of
     * checking again.
     */
    async function onCheckForUpdates() {
        if (devMode) return;
        if (foundUpdate) {
            showUpdateModal(root, foundUpdate);
            return;
        }
        versionButton.disabled = true;
        setStatus('Checking for updates...', 'pending');
        const update = await checkForUpdate();
        versionButton.disabled = false;
        if (update) {
            notifyUpdateFound(update);
            showUpdateModal(root, update);
        } else {
            setStatus(`Up to date (v${packageJson.version})`, 'ok');
        }
    }

    return handle;
}

/**
 * Minimal in-page confirmation modal (resolves true on confirm, false on
 * cancel / Escape / backdrop click). Used instead of `window.confirm`,
 * whose support inside the Tauri 2 macOS webview is not guaranteed.
 */
export function confirmDialog(
    root: HTMLElement,
    options: {
        title: string;
        body: string;
        confirmLabel: string;
        danger?: boolean;
    },
): Promise<boolean> {
    return new Promise((resolve) => {
        const previousFocus = document.activeElement as HTMLElement | null;
        const backdrop = el('div', 'modal-backdrop');
        const card = el('div', 'modal-card');
        card.setAttribute('role', 'dialog');
        card.setAttribute('aria-modal', 'true');
        const title = el('h2', 'modal-title', options.title);
        const text = el('p', 'modal-body', options.body);
        const actions = el('div', 'modal-actions');
        const cancel = button('Cancel', 'btn btn-secondary');
        cancel.dataset.action = 'cancel';
        const confirm = button(
            options.confirmLabel,
            options.danger ? 'btn btn-danger' : 'btn btn-primary',
        );
        confirm.dataset.action = 'confirm';
        actions.append(cancel, confirm);
        card.append(title, text, actions);
        backdrop.appendChild(card);
        root.appendChild(backdrop);
        confirm.focus();

        const finish = (result: boolean) => {
            document.removeEventListener('keydown', onKey, true);
            backdrop.remove();
            previousFocus?.focus?.();
            resolve(result);
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                finish(false);
            }
        };
        document.addEventListener('keydown', onKey, true);
        cancel.addEventListener('click', () => finish(false));
        confirm.addEventListener('click', () => finish(true));
        backdrop.addEventListener('mousedown', (event) => {
            if (event.target === backdrop) finish(false);
        });
    });
}

/**
 * `?`-triggered keyboard-shortcut help overlay. Reuses the same
 * `.modal-backdrop`/`.modal-card` styling as `confirmDialog` (per
 * docs/design/conflate-ui-reference.md's "centered card over a dimmed
 * backdrop" spec) rather than inventing a second modal look. Content is
 * generated straight from `KEYMAP_BINDINGS`, so it can't drift out of sync
 * with the bindings `installKeymap` actually recognizes.
 */
export function showShortcutsHelp(root: HTMLElement): void {
    const previousFocus = document.activeElement as HTMLElement | null;
    const backdrop = el('div', 'modal-backdrop');
    const card = el('div', 'modal-card modal-card-wide');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    const title = el('h2', 'modal-title', 'Keyboard shortcuts');
    const list = el('div', 'shortcuts-list');
    for (const binding of KEYMAP_BINDINGS) {
        const row = el('div', 'shortcuts-row');
        const desc = el('span', 'shortcuts-desc', binding.description);
        const keyCell = el('span', 'shortcuts-key');
        const kbd = document.createElement('kbd');
        kbd.className = 'shortcuts-kbd';
        kbd.textContent = binding.combo;
        keyCell.appendChild(kbd);
        row.append(desc, keyCell);
        list.appendChild(row);
    }
    const actions = el('div', 'modal-actions');
    const close = button('Close', 'btn btn-primary');
    close.dataset.action = 'close';
    actions.append(close);
    card.append(title, list, actions);
    backdrop.appendChild(card);
    root.appendChild(backdrop);
    close.focus();

    const finish = () => {
        document.removeEventListener('keydown', onKey, true);
        backdrop.remove();
        previousFocus?.focus?.();
    };
    const onKey = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            finish();
        }
    };
    document.addEventListener('keydown', onKey, true);
    close.addEventListener('click', finish);
    backdrop.addEventListener('mousedown', (event) => {
        if (event.target === backdrop) finish();
    });
}

/**
 * Non-modal, dismissible notice for a background-found update (see
 * `main.ts`'s silent launch check) — reuses `.dev-banner`'s full-width-strip
 * look rather than inventing new chrome. Dismissing persists
 * `skippedVersion` via `onSkipVersion` so the same version doesn't reappear
 * every launch; "View" opens the full `showUpdateModal` dialog.
 */
export function wireUpdateUi(
    root: HTMLElement,
    update: UpdateInfo,
    options: {
        skippedVersion: string | null;
        onSkipVersion: (version: string) => void;
    },
): void {
    if (update.version === options.skippedVersion) return;

    const banner = el('div', 'update-banner');
    banner.append(
        el(
            'span',
            'update-banner-text',
            `Conflate v${update.version} is available.`,
        ),
    );
    const actions = el('span', 'update-banner-actions');
    const view = button('View', 'btn btn-primary btn-small');
    view.dataset.action = 'view';
    const dismiss = button('Dismiss', 'btn btn-secondary btn-small');
    dismiss.dataset.action = 'dismiss';
    actions.append(view, dismiss);
    banner.append(actions);

    view.addEventListener('click', () => {
        banner.remove();
        showUpdateModal(root, update);
    });
    dismiss.addEventListener('click', () => {
        banner.remove();
        options.onSkipVersion(update.version);
    });

    root.prepend(banner);
}

/**
 * The update dialog: version diff, truncated release notes with a link to
 * the full GitHub release, a download progress bar, and one action button
 * cycling `Update` -> `Downloading... NN%` (disabled) -> `Restart to Update`.
 * Reuses the `.modal-backdrop`/`.modal-card` look already established by
 * `confirmDialog`/`showShortcutsHelp` rather than inventing new chrome.
 */
export function showUpdateModal(
    root: HTMLElement,
    update: UpdateInfo,
    options: { restart?: () => Promise<void> } = {},
): void {
    const restart = options.restart ?? restartToApplyUpdate;
    const previousFocus = document.activeElement as HTMLElement | null;
    const backdrop = el('div', 'modal-backdrop');
    const card = el('div', 'modal-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');

    const title = el('h2', 'modal-title', 'Update available');
    const body = el('div', 'modal-body');
    body.append(
        el(
            'p',
            undefined,
            `Conflate ${update.currentVersion} → ${update.version}`,
        ),
    );
    if (update.body) {
        const notes = update.body.trim();
        const truncated =
            notes.length > 180 ? `${notes.slice(0, 180).trimEnd()}...` : notes;
        body.append(el('p', 'update-notes', truncated));
    }
    const notesLink = document.createElement('a');
    notesLink.href = `${RELEASES_URL}/tag/v${update.version}`;
    notesLink.textContent = 'Read full release notes';
    notesLink.addEventListener('click', (event) => {
        event.preventDefault();
        void import('@tauri-apps/plugin-opener')
            .then(({ openUrl }) => openUrl(notesLink.href))
            .catch(() => {
                // No Tauri runtime (e.g. dev preview) — nothing to open with.
            });
    });
    body.append(notesLink);

    const progress = el('div', 'update-progress');
    const progressBar = el('div', 'update-progress-bar');
    progress.append(progressBar);
    progress.style.display = 'none';
    const errorText = el('p', 'modal-error');
    errorText.style.display = 'none';

    const actions = el('div', 'modal-actions');
    const later = button('Later', 'btn btn-secondary');
    later.dataset.action = 'later';
    const update_ = button('Update', 'btn btn-primary');
    update_.dataset.action = 'update';
    actions.append(later, update_);

    card.append(title, body, progress, errorText, actions);
    backdrop.appendChild(card);
    root.appendChild(backdrop);
    update_.focus();

    let phase: 'idle' | 'downloading' | 'ready' | 'error' = 'idle';

    const finish = () => {
        document.removeEventListener('keydown', onKey, true);
        backdrop.remove();
        previousFocus?.focus?.();
    };
    const onKey = (event: KeyboardEvent) => {
        if (event.key === 'Escape' && phase !== 'downloading') {
            event.preventDefault();
            event.stopPropagation();
            finish();
        }
    };
    document.addEventListener('keydown', onKey, true);
    later.addEventListener('click', () => {
        if (phase !== 'downloading') finish();
    });
    backdrop.addEventListener('mousedown', (event) => {
        if (event.target === backdrop && phase !== 'downloading') finish();
    });

    update_.addEventListener('click', () => {
        if (phase === 'idle' || phase === 'error') {
            phase = 'downloading';
            update_.disabled = true;
            later.disabled = true;
            update_.textContent = 'Downloading...';
            errorText.style.display = 'none';
            progress.style.display = '';
            downloadAndInstallUpdate(update, (p) => {
                if (p.phase === 'downloading') {
                    const percent =
                        p.total && p.total > 0
                            ? Math.round((p.downloaded / p.total) * 100)
                            : null;
                    progressBar.style.width = `${percent ?? 0}%`;
                    update_.textContent =
                        percent === null
                            ? 'Downloading...'
                            : `Downloading... ${percent}%`;
                } else {
                    phase = 'ready';
                    update_.disabled = false;
                    later.disabled = false;
                    update_.textContent = 'Restart to Update';
                    progressBar.style.width = '100%';
                }
            }).catch((err) => {
                // A failed download/install must never leave the dialog
                // stuck mid-flight with no way to close it — fall back to
                // a retryable error state instead of an unhandled rejection.
                phase = 'error';
                update_.disabled = false;
                later.disabled = false;
                update_.textContent = 'Retry';
                progress.style.display = 'none';
                errorText.style.display = '';
                errorText.textContent = `Download failed: ${String(err)}`;
            });
        } else if (phase === 'ready') {
            void restart();
        }
    });
}

function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function button(
    text: string,
    className: string,
    title?: string,
): HTMLButtonElement {
    const node = el('button', className, text);
    node.type = 'button';
    if (title) {
        node.title = title;
        node.setAttribute('aria-label', title);
    }
    return node;
}

/** Same as `button`, but with a static trusted SVG icon instead of a text label. */
function iconButton(
    svg: string,
    className: string,
    title: string,
): HTMLButtonElement {
    const node = el('button', className);
    node.type = 'button';
    node.innerHTML = svg;
    node.title = title;
    node.setAttribute('aria-label', title);
    return node;
}
