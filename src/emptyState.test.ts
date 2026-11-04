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

test('clicking "Open Repository..." calls onPickRepo', () => {
    const onPickRepo = vi.fn();
    mountEmptyState(root, { onPickRepo, onOpenFile: vi.fn() });
    root.querySelector<HTMLButtonElement>(
        '.empty-state button.btn-primary',
    )!.click();
    expect(onPickRepo).toHaveBeenCalled();
});

test('renderScanResult(notARepo) shows a not-a-repository message', () => {
    const handle = mountEmptyState(root, {
        onPickRepo: vi.fn(),
        onOpenFile: vi.fn(),
    });
    handle.renderScanResult({ kind: 'notARepo' });
    expect(root.querySelector('.empty-state-message')?.textContent).toContain(
        'not a git repository',
    );
});

test('renderScanResult(noMergeInProgress) shows a no-merge message', () => {
    const handle = mountEmptyState(root, {
        onPickRepo: vi.fn(),
        onOpenFile: vi.fn(),
    });
    handle.renderScanResult({ kind: 'noMergeInProgress' });
    expect(root.querySelector('.empty-state-message')?.textContent).toContain(
        'No merge in progress',
    );
});

test('renderScanResult(conflicted) lists files; clicking one calls onOpenFile', () => {
    const onOpenFile = vi.fn();
    const handle = mountEmptyState(root, { onPickRepo: vi.fn(), onOpenFile });
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
    rows[1].click();
    expect(onOpenFile).toHaveBeenCalledWith('sub/b.txt');
});

test('showFileListMessage replaces the file list with a plain message', () => {
    const handle = mountEmptyState(root, {
        onPickRepo: vi.fn(),
        onOpenFile: vi.fn(),
    });
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
