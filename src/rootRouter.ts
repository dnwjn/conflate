import { type MountAppHandle, type MountAppOptions, mountApp } from './app';
import { isTauriRuntime } from './devStub';
import { type EmptyStateHandle, mountEmptyState } from './emptyState';
import { showUpdateModal } from './modals';
import {
    getLaunchMode,
    loadConflictFromRepo,
    pickRepoFolder,
    saveRepoConflictResolution,
    scanRepoForConflicts,
} from './repoBrowser';

/**
 * Routes between the real merge view and the empty-state repo browser: a
 * `git mergetool` launch (or dev stub) goes straight to `mountApp`, while a
 * bare launch (double-click, Dock, Spotlight — no merge input on argv) shows
 * the repo browser until the user picks a file to resolve.
 */
export async function mountRoot(
    root: HTMLElement,
    options: MountAppOptions = {},
): Promise<MountAppHandle> {
    if (!isTauriRuntime() || (await getLaunchMode())) {
        return mountApp(root, options);
    }
    return mountEmptyStateFlow(root, options);
}

async function mountEmptyStateFlow(
    root: HTMLElement,
    options: MountAppOptions,
): Promise<MountAppHandle> {
    let repoPath: string | null = null;
    let current: MountAppHandle = { notifyUpdateFound: () => {} };
    let pendingUpdate:
        | Parameters<MountAppHandle['notifyUpdateFound']>[0]
        | null = null;

    async function rescan(emptyHandle: EmptyStateHandle, path: string) {
        try {
            emptyHandle.renderScanResult(await scanRepoForConflicts(path));
        } catch (err) {
            emptyHandle.showFileListMessage(
                `Could not scan repository: ${String(err)}`,
            );
        }
    }

    function showEmptyState(): EmptyStateHandle {
        const emptyHandle = mountEmptyState(root, {
            onPickRepo: () => void onPickRepo(emptyHandle),
            onOpenFile: (filePath) => void onOpenFile(emptyHandle, filePath),
            onUpdateFound: (update) => showUpdateModal(root, update),
        });
        current = emptyHandle;
        if (pendingUpdate) current.notifyUpdateFound(pendingUpdate);
        return emptyHandle;
    }

    async function onPickRepo(emptyHandle: EmptyStateHandle) {
        const picked = await pickRepoFolder();
        if (!picked) return;
        repoPath = picked;
        await rescan(emptyHandle, picked);
    }

    async function onOpenFile(emptyHandle: EmptyStateHandle, filePath: string) {
        if (!repoPath) return;
        const openRepoPath = repoPath;
        let input: Awaited<ReturnType<typeof loadConflictFromRepo>>;
        try {
            input = await loadConflictFromRepo(openRepoPath, filePath);
        } catch (err) {
            emptyHandle.showFileListMessage(
                `Could not load ${filePath}: ${String(err)}`,
            );
            return;
        }
        current = await mountApp(root, {
            ...options,
            preloadedInput: input,
            saveOverride: (content) =>
                saveRepoConflictResolution(openRepoPath, filePath, content),
            abortOverride: () => Promise.resolve(),
            onSaveOrAbortComplete: () => {
                void rescan(showEmptyState(), openRepoPath);
            },
        });
        if (pendingUpdate) current.notifyUpdateFound(pendingUpdate);
    }

    showEmptyState();
    return {
        notifyUpdateFound: (update) => {
            pendingUpdate = update;
            current.notifyUpdateFound(update);
        },
    };
}
