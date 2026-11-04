import type { RepoScanResult } from './bindings';
import { buildBrandHeader, createUpdateChecker } from './brandHeader';
import type { UpdateInfo } from './update';

export interface EmptyStateHandle {
    /** Renders a repo scan's result into the file-list area. */
    renderScanResult(result: RepoScanResult): void;
    /** Replaces the file-list area with a plain message (e.g. a per-file load error). */
    showFileListMessage(message: string): void;
    /** Same contract as `MountAppHandle.notifyUpdateFound` — sets the header's version-button dot. */
    notifyUpdateFound(update: UpdateInfo): void;
}

export interface EmptyStateOptions {
    /** Called when the user clicks "Open Repository...". */
    onPickRepo: () => void;
    /** Called when the user clicks a conflicted file row. */
    onOpenFile: (filePath: string) => void;
    /** Called when the header's version button finds an update; the caller shows it (e.g. `showUpdateModal`). */
    onUpdateFound: (update: UpdateInfo) => void;
}

/**
 * Renders the screen shown when Conflate is launched with no CLI args at
 * all (double-click, Dock, Spotlight) instead of via `git mergetool`: the
 * same brand header/status-bar frame as the real merge view (`mountApp`),
 * with an explanation of what Conflate is, how to invoke it for real, and a
 * path to find a conflict directly by picking a repo folder.
 */
export function mountEmptyState(
    root: HTMLElement,
    options: EmptyStateOptions,
): EmptyStateHandle {
    root.innerHTML = '';
    root.classList.add('app');

    const { toolbar, versionButton } = buildBrandHeader();

    const body = el('main', 'empty-state-host');
    const wrap = el('div', 'empty-state');
    wrap.append(
        el(
            'p',
            'empty-state-body',
            'Conflate is a git mergetool — it normally opens automatically when you run `git mergetool` on a conflicted file. You can also open a repository below to find a merge conflict directly.',
        ),
    );
    const pickButton = button('Open Repository...', 'btn btn-primary');
    wrap.append(pickButton);
    const fileList = el('div', 'empty-state-filelist');
    wrap.append(fileList);
    body.append(wrap);

    const statusBar = el('footer', 'statusbar');
    const statusText = el(
        'span',
        'status-text',
        'Pick a repository to look for a merge conflict.',
    );
    statusText.id = 'app-message';
    statusBar.append(statusText);

    root.append(toolbar, body, statusBar);

    function setStatus(text: string) {
        statusText.textContent = text;
    }

    const updateChecker = createUpdateChecker({
        versionButton,
        devMode: false,
        setStatus,
        onUpdateFound: options.onUpdateFound,
    });

    pickButton.addEventListener('click', () => options.onPickRepo());

    function showFileListMessage(message: string) {
        fileList.innerHTML = '';
        fileList.append(el('p', 'empty-state-message', message));
        setStatus(message);
    }

    function renderScanResult(result: RepoScanResult) {
        fileList.innerHTML = '';
        if (result.kind === 'notARepo') {
            showFileListMessage('This folder is not a git repository.');
            return;
        }
        if (result.kind === 'noMergeInProgress') {
            showFileListMessage(
                'No merge in progress in this repository — nothing to resolve.',
            );
            return;
        }
        const list = el('ul', 'empty-state-files');
        for (const file of result.files) {
            const item = el('li', 'empty-state-file-item');
            const row = button(file.path, 'empty-state-file-row');
            row.addEventListener('click', () => options.onOpenFile(file.path));
            item.append(row);
            list.append(item);
        }
        fileList.append(list);
        setStatus(
            `${result.files.length} conflict${result.files.length === 1 ? '' : 's'} found.`,
        );
    }

    return {
        renderScanResult,
        showFileListMessage,
        notifyUpdateFound: updateChecker.notifyUpdateFound,
    };
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

function button(text: string, className: string): HTMLButtonElement {
    const node = el('button', className, text);
    node.type = 'button';
    return node;
}
