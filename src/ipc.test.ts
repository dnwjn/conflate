import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { beforeEach, expect, test, vi } from 'vitest';
import {
    abortMerge,
    computeThreeWayMerge,
    computeWordDiff,
    getMergeInput,
    saveResult,
} from './ipc';

beforeEach(() => {
    clearMocks();
});

test('getMergeInput calls the get_merge_input command and returns its payload', async () => {
    mockIPC((cmd) => {
        if (cmd === 'get_merge_input') {
            return { base: null, local: 'a', remote: 'b', languageHint: null };
        }
    });
    const result = await getMergeInput();
    expect(result.local).toBe('a');
    expect(result.remote).toBe('b');
    expect(result.base).toBeNull();
    expect(result.languageHint).toBeNull();
});

test('getMergeInput propagates a rejection from the backend', async () => {
    mockIPC((cmd) => {
        if (cmd === 'get_merge_input') {
            return Promise.reject('boom: cannot read local file');
        }
    });
    await expect(getMergeInput()).rejects.toBe('boom: cannot read local file');
});

test('saveResult calls save_result with the given args', async () => {
    const spy = vi.fn();
    mockIPC((cmd, args) => {
        if (cmd === 'save_result') {
            spy(args);
            return null;
        }
    });
    await saveResult('merged content', 0, false);
    expect(spy).toHaveBeenCalledWith({
        content: 'merged content',
        unresolvedCount: 0,
        force: false,
    });
});

test('abortMerge calls abort_merge', async () => {
    const spy = vi.fn();
    mockIPC((cmd) => {
        if (cmd === 'abort_merge') {
            spy();
            return null;
        }
    });
    await abortMerge();
    expect(spy).toHaveBeenCalled();
});

test('computeThreeWayMerge calls compute_three_way_merge_command with base/local/remote', async () => {
    const spy = vi.fn();
    mockIPC((cmd, args) => {
        if (cmd === 'compute_three_way_merge_command') {
            spy(args);
            return { hunks: [], auto_merged_text: 'x', conflict_count: 0 };
        }
    });
    const result = await computeThreeWayMerge(null, 'l', 'r');
    expect(spy).toHaveBeenCalledWith({ base: null, local: 'l', remote: 'r' });
    expect(result.auto_merged_text).toBe('x');
});

test('computeThreeWayMerge propagates an internal-invariant rejection', async () => {
    mockIPC((cmd) => {
        if (cmd === 'compute_three_way_merge_command') {
            return Promise.reject('internal invariant violated');
        }
    });
    await expect(computeThreeWayMerge('b', 'l', 'r')).rejects.toBe(
        'internal invariant violated',
    );
});

test('computeWordDiff calls compute_word_diff_command with old/newText', async () => {
    const spy = vi.fn();
    mockIPC((cmd, args) => {
        if (cmd === 'compute_word_diff_command') {
            spy(args);
            return [{ kind: 'Equal', text: 'a' }];
        }
    });
    const ops = await computeWordDiff('a', 'a');
    expect(spy).toHaveBeenCalledWith({ old: 'a', newText: 'a' });
    expect(ops).toEqual([{ kind: 'Equal', text: 'a' }]);
});
