import type {
    MergeInputPayload_Serialize as MergeInputPayload,
    RepoScanResult,
} from './bindings';
import { commands } from './bindings';

export type { MergeInputPayload, RepoScanResult };

/** Calls the `get_launch_mode` Tauri command: `true` for a `git mergetool`-style launch. */
export async function getLaunchMode(): Promise<boolean> {
    return commands.getLaunchMode();
}

/**
 * Calls the `pick_repo_folder` Tauri command (native folder picker). `null`
 * if the user cancels.
 */
export async function pickRepoFolder(): Promise<string | null> {
    return commands.pickRepoFolder();
}

/** Calls the `scan_repo_for_conflicts` Tauri command. */
export async function scanRepoForConflicts(
    repoPath: string,
): Promise<RepoScanResult> {
    return commands.scanRepoForConflicts(repoPath);
}

/**
 * Calls the `load_conflict_from_repo` Tauri command. Rejects (with the
 * backend's error string) if the file's stages can't be read from git.
 */
export async function loadConflictFromRepo(
    repoPath: string,
    filePath: string,
): Promise<MergeInputPayload> {
    return commands.loadConflictFromRepo(repoPath, filePath);
}

/**
 * Calls the `save_repo_conflict_resolution` Tauri command: writes `content`
 * to the real working-tree file and stages it (`git add`).
 */
export async function saveRepoConflictResolution(
    repoPath: string,
    filePath: string,
    content: string,
): Promise<void> {
    await commands.saveRepoConflictResolution(repoPath, filePath, content);
}
