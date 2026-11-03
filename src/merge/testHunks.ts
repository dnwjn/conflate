import type { Hunk } from '../bindings';

/**
 * Test helper: builds a full `Hunk` from just the fields a test cares about,
 * filling the rest with inert defaults (same idea as the private helper in
 * `conflictModel.test.ts`). Line ranges are 0-based and end-EXCLUSIVE.
 */
export function makeHunk(
    partial: Pick<Hunk, 'start_line' | 'end_line' | 'kind'> & Partial<Hunk>,
): Hunk {
    return {
        local_start_line: partial.start_line,
        local_end_line: partial.end_line,
        remote_start_line: partial.start_line,
        remote_end_line: partial.end_line,
        base_text: '',
        local_text: '',
        remote_text: '',
        merged_text: '',
        ...partial,
    };
}
