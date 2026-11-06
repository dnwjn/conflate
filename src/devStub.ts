import baseSample from '../dev-fixtures/sample/base.ts?raw';
import localSample from '../dev-fixtures/sample/local.ts?raw';
import remoteSample from '../dev-fixtures/sample/remote.ts?raw';
import type {
    MergeInputPayload,
    MergeInputPayload_Serialize,
    ThreeWayMergeResult,
} from './bindings';

/** True outside a real Tauri webview (e.g. `pnpm run dev` opened as a plain browser tab). */
export function isTauriRuntime(): boolean {
    return '__TAURI_INTERNALS__' in window;
}

/**
 * Stub merge input/result for UI preview when there's no Tauri backend to
 * call `get_merge_input`/`compute_three_way_merge_command` on. Not a
 * reimplementation of the real Myers-diff merge (that only exists in Rust,
 * `src-tauri/src/diff/three_way.rs`) — just one whole-file `Conflict` hunk so
 * the 3-pane view has something real to render and drag around.
 */
export function devStubMergeInput(): MergeInputPayload_Serialize {
    return {
        base: baseSample,
        local: localSample,
        remote: remoteSample,
        languageHint: 'ts',
        fileName: 'sample.ts (dev preview)',
        fullPath: '/Users/you/sample-project/dev-fixtures/sample/sample.ts',
        localBranch: 'feature/pricing',
        remoteBranch: 'main',
    };
}

export function devStubMergeResult(
    input: MergeInputPayload,
): ThreeWayMergeResult {
    const localLines = input.local.split('\n').length;
    const remoteLines = input.remote.split('\n').length;
    return {
        hunks: [
            {
                start_line: 0,
                end_line: localLines,
                kind: 'Conflict',
                local_start_line: 0,
                local_end_line: localLines,
                remote_start_line: 0,
                remote_end_line: remoteLines,
                base_text: input.base ?? '',
                local_text: input.local,
                remote_text: input.remote,
                merged_text: input.local,
            },
        ],
        auto_merged_text: input.local,
        conflict_count: 1,
    };
}
