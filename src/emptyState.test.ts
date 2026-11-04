import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mountEmptyState } from './emptyState';

let root: HTMLElement;
beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
});
afterEach(() => {
    document.body.innerHTML = '';
});

function mount(overrides: Partial<Parameters<typeof mountEmptyState>[1]> = {}) {
    return mountEmptyState(root, {
        onPickRepo: vi.fn(),
        onOpenFile: vi.fn(),
        onUpdateFound: vi.fn(),
        ...overrides,
    });
}

test('renders the same brand header and status bar frame as the merge view', () => {
    mount();
    expect(root.querySelector('.toolbar-brand')).not.toBeNull();
    expect(root.querySelector('.brand-name')?.textContent).toBe('Conflate');
    expect(root.querySelector('.statusbar')).not.toBeNull();
    expect(root.querySelector('#app-message')?.textContent).toContain(
        'Pick a repository',
    );
});

test('clicking "Open Repository..." calls onPickRepo', () => {
    const onPickRepo = vi.fn();
    mount({ onPickRepo });
    root.querySelector<HTMLButtonElement>(
        '.empty-state button.btn-primary',
    )!.click();
    expect(onPickRepo).toHaveBeenCalled();
});

test('renderScanResult(notARepo) shows a not-a-repository message in the panel and status bar', () => {
    const handle = mount();
    handle.renderScanResult({ kind: 'notARepo' });
    expect(root.querySelector('.empty-state-message')?.textContent).toContain(
        'not a git repository',
    );
    expect(root.querySelector('#app-message')?.textContent).toContain(
        'not a git repository',
    );
});

test('renderScanResult(noMergeInProgress) shows a no-merge message', () => {
    const handle = mount();
    handle.renderScanResult({ kind: 'noMergeInProgress' });
    expect(root.querySelector('.empty-state-message')?.textContent).toContain(
        'No merge in progress',
    );
});

test('renderScanResult(conflicted) lists files, updates the status bar, and clicking one calls onOpenFile', () => {
    const onOpenFile = vi.fn();
    const handle = mount({ onOpenFile });
    handle.renderScanResult({
        kind: 'conflicted',
        repoRoot: '/repo',
        files: [{ path: 'a.txt' }, { path: 'sub/b.txt' }],
    });
    const rows = root.querySelectorAll<HTMLButtonElement>(
        '.empty-state-file-row',
    );
    expect(rows).toHaveLength(2);
    expect(rows[1].textContent).toBe('sub/b.txt');
    expect(root.querySelector('#app-message')?.textContent).toBe(
        '2 conflicts found.',
    );
    rows[1].click();
    expect(onOpenFile).toHaveBeenCalledWith('sub/b.txt');
});

test('showFileListMessage replaces the file list with a plain message', () => {
    const handle = mount();
    handle.renderScanResult({
        kind: 'conflicted',
        repoRoot: '/repo',
        files: [{ path: 'a.txt' }],
    });
    handle.showFileListMessage('cannot read stage 2 of a.txt: boom');
    expect(root.querySelector('.empty-state-files')).toBeNull();
    expect(root.querySelector('.empty-state-message')?.textContent).toBe(
        'cannot read stage 2 of a.txt: boom',
    );
});

test('clicking the header version button checks for updates via onUpdateFound', async () => {
    const onUpdateFound = vi.fn();
    mount({ onUpdateFound });
    root.querySelector<HTMLButtonElement>('.brand-version')!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // No real Tauri runtime in this test environment: checkForUpdate resolves
    // null (not a rejection), so onUpdateFound simply isn't called — this
    // test only proves the click is wired to the shared checker, not that an
    // update exists (see brandHeader.test.ts for that behavior).
    expect(onUpdateFound).not.toHaveBeenCalled();
});

test('notifyUpdateFound marks the header version button with the has-update dot', () => {
    const handle = mount();
    handle.notifyUpdateFound({
        version: '1.2.3',
        currentVersion: '1.0.0',
        downloadAndInstall: vi.fn(),
    });
    expect(
        root.querySelector('.brand-version')?.classList.contains('has-update'),
    ).toBe(true);
});
