import { commands } from "./bindings";
import type {
  MergeInputPayload_Serialize as MergeInputPayload,
  ThreeWayMergeResult,
  WordDiffOp,
} from "./bindings";

export type { MergeInputPayload };

/**
 * Calls the `get_merge_input` Tauri command. The backend returns
 * `Result<MergeInputPayload, String>`, so a backend-side `Err` causes this
 * promise to reject (with the error string) rather than being caught here —
 * callers are expected to handle that rejection themselves.
 */
export async function getMergeInput(): Promise<MergeInputPayload> {
  return commands.getMergeInput();
}

/**
 * Calls the `save_result` Tauri command. On success, the backend process
 * exits (git mergetool contract), so this promise may never resolve in
 * practice; on failure (e.g. unresolved conflicts without `force`), it
 * rejects with the backend's error string.
 */
export async function saveResult(
  content: string,
  unresolvedCount: number,
  force: boolean,
): Promise<void> {
  await commands.saveResult(content, unresolvedCount, force);
}

/**
 * Calls the `abort_merge` Tauri command. The backend exits the process
 * immediately, so this promise may never resolve in practice.
 */
export async function abortMerge(): Promise<void> {
  await commands.abortMerge();
}

/**
 * Calls the `compute_three_way_merge_command` Tauri command. `base: null`
 * means "no common ancestor" (add/add conflict). Rejects (with the backend's
 * error string) only on an internal-invariant violation in the merge — the
 * caller must handle that rejection and show an error state.
 */
export async function computeThreeWayMerge(
  base: string | null,
  local: string,
  remote: string,
): Promise<ThreeWayMergeResult> {
  return commands.computeThreeWayMergeCommand(base, local, remote);
}

/** Calls the `compute_word_diff_command` Tauri command (infallible backend-side). */
export async function computeWordDiff(oldText: string, newText: string): Promise<WordDiffOp[]> {
  return commands.computeWordDiffCommand(oldText, newText);
}
