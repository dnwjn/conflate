import brandMarkIcon from './assets/icons/brand-mark.svg?raw';
import type { RepoScanResult } from './bindings';

export interface EmptyStateHandle {
    /** Renders a repo scan's result into the file-list area. */
    renderScanResult(result: RepoScanResult): void;
    /** Replaces the file-list area with a plain message (e.g. a per-file load error). */
    showFileListMessage(message: string): void;
}

export interface EmptyStateCallbacks {
    /** Called when the user clicks "Open Repository...". */
    onPickRepo: () => void;
    /** Called when the user clicks a conflicted file row. */
    onOpenFile: (filePath: string) => void;
}

/**
 * Renders the screen shown when Conflate is launched with no CLI args at
 * all (double-click, Dock, Spotlight) instead of via `git mergetool`:
 * what Conflate is, how to invoke it for real, and a path to find a
 * conflict directly by picking a repo folder.
 */
export function mountEmptyState(
    root: HTMLElement,
    callbacks: EmptyStateCallbacks,
): EmptyStateHandle {
    root.innerHTML = '';
    root.classList.add('app', 'empty-state-app');

    const wrap = el('div', 'empty-state');
    const brandMark = el('span', 'empty-state-mark');
    brandMark.innerHTML = brandMarkIcon;
    wrap.append(
        brandMark,
        el('h1', 'empty-state-title', 'Conflate'),
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

    root.append(wrap);

    pickButton.addEventListener('click', () => callbacks.onPickRepo());

    function showFileListMessage(message: string) {
        fileList.innerHTML = '';
        fileList.append(el('p', 'empty-state-message', message));
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
            row.addEventListener('click', () =>
                callbacks.onOpenFile(file.path),
            );
            item.append(row);
            list.append(item);
        }
        fileList.append(list);
    }

    return { renderScanResult, showFileListMessage };
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
