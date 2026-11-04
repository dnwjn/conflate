import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { beforeEach, expect, test, vi } from 'vitest';
import {
    getLaunchMode,
    loadConflictFromRepo,
    pickRepoFolder,
    saveRepoConflictResolution,
    scanRepoForConflicts,
} from './repoBrowser';

beforeEach(() => {
    clearMocks();
});

test('getLaunchMode calls get_launch_mode and returns its boolean', async () => {
    mockIPC((cmd) => {
        if (cmd === 'get_launch_mode') return true;
    });
    expect(await getLaunchMode()).toBe(true);
});

test('pickRepoFolder calls pick_repo_folder and returns the chosen path', async () => {
    mockIPC((cmd) => {
        if (cmd === 'pick_repo_folder') return '/repo';
    });
    expect(await pickRepoFolder()).toBe('/repo');
});

test('pickRepoFolder returns null when the user cancels', async () => {
    mockIPC((cmd) => {
        if (cmd === 'pick_repo_folder') return null;
    });
    expect(await pickRepoFolder()).toBeNull();
});

test('scanRepoForConflicts calls scan_repo_for_conflicts with repoPath', async () => {
    const spy = vi.fn();
    mockIPC((cmd, args) => {
        if (cmd === 'scan_repo_for_conflicts') {
            spy(args);
            return {
                kind: 'conflicted',
                repoRoot: '/repo',
                files: [{ path: 'a.txt' }],
            };
        }
    });
    const result = await scanRepoForConflicts('/repo');
    expect(spy).toHaveBeenCalledWith({ repoPath: '/repo' });
    expect(result).toEqual({
        kind: 'conflicted',
        repoRoot: '/repo',
        files: [{ path: 'a.txt' }],
    });
});

test('loadConflictFromRepo calls load_conflict_from_repo with repoPath/filePath', async () => {
    const spy = vi.fn();
    mockIPC((cmd, args) => {
        if (cmd === 'load_conflict_from_repo') {
            spy(args);
            return {
                base: null,
                local: 'l',
                remote: 'r',
                languageHint: null,
                fileName: 'a.txt',
                fullPath: '/repo/a.txt',
                localBranch: null,
                remoteBranch: null,
            };
        }
    });
    const result = await loadConflictFromRepo('/repo', 'a.txt');
    expect(spy).toHaveBeenCalledWith({ repoPath: '/repo', filePath: 'a.txt' });
    expect(result.local).toBe('l');
});

test('loadConflictFromRepo propagates a rejection from the backend', async () => {
    mockIPC((cmd) => {
        if (cmd === 'load_conflict_from_repo') {
            return Promise.reject('cannot read stage 2 of a.txt');
        }
    });
    await expect(loadConflictFromRepo('/repo', 'a.txt')).rejects.toBe(
        'cannot read stage 2 of a.txt',
    );
});

test('saveRepoConflictResolution calls save_repo_conflict_resolution with its args', async () => {
    const spy = vi.fn();
    mockIPC((cmd, args) => {
        if (cmd === 'save_repo_conflict_resolution') {
            spy(args);
            return null;
        }
    });
    await saveRepoConflictResolution('/repo', 'a.txt', 'resolved\n');
    expect(spy).toHaveBeenCalledWith({
        repoPath: '/repo',
        filePath: 'a.txt',
        content: 'resolved\n',
    });
});
