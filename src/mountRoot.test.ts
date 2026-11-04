import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mountRoot } from './app';
import { makeHunk } from './merge/testHunks';

if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect();
}

function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

let root: HTMLElement;
beforeEach(() => {
    clearMocks();
    root = document.createElement('div');
    document.body.appendChild(root);
});
afterEach(() => {
    document.body.innerHTML = '';
});

const mergeResult = {
    auto_merged_text: 'L\n',
    conflict_count: 1,
    hunks: [
        makeHunk({
            start_line: 0,
            end_line: 1,
            kind: 'Conflict',
            base_text: 'a\n',
            local_text: 'L\n',
            remote_text: 'R\n',
            merged_text: 'L\n',
        }),
    ],
};

test('launch mode true mounts the real merge view (calls get_merge_input)', async () => {
    const calls: string[] = [];
    mockIPC((cmd) => {
        calls.push(cmd);
        if (cmd === 'get_launch_mode') return true;
        if (cmd === 'get_merge_input') {
            return {
                base: 'a',
                local: 'L',
                remote: 'R',
                languageHint: null,
                fileName: 'f.txt',
                fullPath: '/repo/f.txt',
            };
        }
        if (cmd === 'compute_three_way_merge_command') return mergeResult;
        if (cmd === 'compute_word_diff_command') return [];
        return null;
    });
    await mountRoot(root);
    expect(calls).toContain('get_merge_input');
    expect(root.querySelector('.tw-pane')).not.toBeNull();
    expect(root.querySelector('.empty-state')).toBeNull();
});

test('launch mode false mounts the empty-state screen', async () => {
    mockIPC((cmd) => {
        if (cmd === 'get_launch_mode') return false;
        return null;
    });
    await mountRoot(root);
    expect(root.querySelector('.empty-state')).not.toBeNull();
    expect(root.querySelector('.tw-pane')).toBeNull();
});

test('repo browser flow: pick repo, see conflicted file, open it into the merge view', async () => {
    mockIPC((cmd) => {
        if (cmd === 'get_launch_mode') return false;
        if (cmd === 'pick_repo_folder') return '/repo';
        if (cmd === 'scan_repo_for_conflicts') {
            return {
                kind: 'conflicted',
                repoRoot: '/repo',
                files: [{ path: 'a.txt' }],
            };
        }
        if (cmd === 'load_conflict_from_repo') {
            return {
                base: 'a',
                local: 'L',
                remote: 'R',
                languageHint: null,
                fileName: 'a.txt',
                fullPath: '/repo/a.txt',
            };
        }
        if (cmd === 'compute_three_way_merge_command') return mergeResult;
        if (cmd === 'compute_word_diff_command') return [];
        return null;
    });

    await mountRoot(root);
    root.querySelector<HTMLButtonElement>('.btn-primary')!.click();
    await flush();

    const row = root.querySelector<HTMLButtonElement>('.empty-state-file-row');
    expect(row?.textContent).toBe('a.txt');
    row!.click();
    await flush();

    expect(root.querySelector('.tw-pane')).not.toBeNull();
    expect(root.querySelector('.empty-state')).toBeNull();
});

test('saving a repo-opened conflict calls save_repo_conflict_resolution and returns to the file list', async () => {
    const saveSpy = vi.fn();
    let scanCount = 0;
    mockIPC((cmd, args) => {
        if (cmd === 'get_launch_mode') return false;
        if (cmd === 'pick_repo_folder') return '/repo';
        if (cmd === 'scan_repo_for_conflicts') {
            scanCount += 1;
            return scanCount === 1
                ? {
                      kind: 'conflicted',
                      repoRoot: '/repo',
                      files: [{ path: 'a.txt' }],
                  }
                : { kind: 'noMergeInProgress' };
        }
        if (cmd === 'load_conflict_from_repo') {
            return {
                base: 'a',
                local: 'L',
                remote: 'R',
                languageHint: null,
                fileName: 'a.txt',
                fullPath: '/repo/a.txt',
            };
        }
        if (cmd === 'compute_three_way_merge_command') return mergeResult;
        if (cmd === 'compute_word_diff_command') return [];
        if (cmd === 'save_repo_conflict_resolution') {
            saveSpy(args);
            return null;
        }
        return null;
    });

    await mountRoot(root);
    root.querySelector<HTMLButtonElement>('.btn-primary')!.click();
    await flush();
    root.querySelector<HTMLButtonElement>('.empty-state-file-row')!.click();
    await flush();

    root.querySelector<HTMLButtonElement>('#save-button')!.click();
    await flush();
    // One conflict is still unresolved -> the "save anyway?" confirm modal.
    root.querySelector<HTMLButtonElement>('[data-action="confirm"]')!.click();
    await flush();

    expect(saveSpy).toHaveBeenCalledWith(
        expect.objectContaining({ repoPath: '/repo', filePath: 'a.txt' }),
    );
    expect(root.querySelector('.empty-state')).not.toBeNull();
    expect(root.querySelector('.empty-state-message')?.textContent).toContain(
        'No merge in progress',
    );
});
