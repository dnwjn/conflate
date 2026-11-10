import { KEYMAP_BINDINGS } from './keymap';
import { renderMarkdown } from './markdown';
import {
    downloadAndInstallUpdate,
    restartToApplyUpdate,
    type UpdateInfo,
} from './update';

/** Matches `endpoints`/the release page in `.github/workflows/release.yml` and `tauri.conf.json`. */
const RELEASES_URL = 'https://github.com/dnwjn/conflate/releases';

export function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

export function button(
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
export function iconButton(
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
 * The update dialog: version diff, full release notes in a scrollable
 * panel with a link to the full GitHub release, a download progress bar,
 * and one action button cycling `Update` -> `Downloading... NN%`
 * (disabled) -> `Restart to Update`. Reuses the `.modal-backdrop` look
 * already established by `confirmDialog`/`showShortcutsHelp` rather than
 * inventing new chrome.
 */
export function showUpdateModal(
    root: HTMLElement,
    update: UpdateInfo,
    options: { restart?: () => Promise<void> } = {},
): void {
    const restart = options.restart ?? restartToApplyUpdate;
    const previousFocus = document.activeElement as HTMLElement | null;
    const backdrop = el('div', 'modal-backdrop');
    const card = el('div', 'modal-card modal-card-update');
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
        const notes = el('div', 'update-notes');
        notes.innerHTML = renderMarkdown(update.body.trim());
        body.append(notes);
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
