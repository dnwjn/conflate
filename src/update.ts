/**
 * Self-update checks via `tauri-plugin-updater`, against the public GitHub
 * releases endpoint `tauri-apps/tauri-action` publishes `latest.json` to
 * (`tauri.conf.json`'s `plugins.updater.endpoints`) — see
 * `.github/workflows/release.yml` for how release artifacts get signed and
 * attached.
 *
 * Set `VITE_STUB_UPDATE` (see `package.json`'s `dev:stub` script) to skip
 * the real check entirely and exercise the update UI with canned data
 * instead — useful since there's no real Tauri runtime talking to a real
 * release endpoint under `pnpm run dev`/`pnpm run dev:stub`.
 */

import { relaunch } from '@tauri-apps/plugin-process';
import type { CheckOptions, DownloadEvent } from '@tauri-apps/plugin-updater';
import { check } from '@tauri-apps/plugin-updater';
import packageJson from '../package.json';

/**
 * The subset of `@tauri-apps/plugin-updater`'s `Update` class the UI
 * actually touches. A real `Update` instance satisfies this structurally;
 * so does `createMockUpdate`'s dev-mode stand-in, which cannot construct a
 * real `Update` (it extends `Resource` and expects a backend-issued `rid`).
 */
export interface UpdateInfo {
    readonly version: string;
    readonly currentVersion: string;
    readonly body?: string;
    downloadAndInstall(onEvent?: (event: DownloadEvent) => void): Promise<void>;
}

/** Bumps the patch component, so the stub plausibly looks like "a newer release". */
function stubNextVersion(version: string): string {
    const parts = version.split('.');
    const patch = Number(parts[2] ?? 0);
    parts[2] = String(Number.isFinite(patch) ? patch + 1 : 1);
    return parts.join('.');
}

/**
 * Best-effort: resolves to `null` on any failure (no Tauri runtime, no
 * network, manifest failure) rather than throwing, so a background check
 * can never interrupt the merge flow.
 */
export async function checkForUpdate(
    options: CheckOptions = {},
): Promise<UpdateInfo | null> {
    if (import.meta.env.VITE_STUB_UPDATE) {
        return createMockUpdate({
            version: stubNextVersion(packageJson.version),
            currentVersion: packageJson.version,
            body: [
                "## What's Changed",
                '* Improve merge conflict highlighting by @dnwjn in #42',
                '* Fix drag-and-drop on Windows by @dnwjn in #41',
                '* Stub release notes for exercising the update UI under `pnpm run dev:stub` by @dnwjn in #40',
                '',
                '## New Contributors',
                '* @someone made their first contribution in #39',
                '',
                '**Full Changelog**: https://github.com/dnwjn/conflate/compare/v0.1.0...v0.2.0',
            ].join('\n'),
        });
    }
    try {
        return await check(options);
    } catch {
        return null;
    }
}

export type UpdatePhase = 'downloading' | 'ready';

export interface UpdateProgress {
    phase: UpdatePhase;
    downloaded: number;
    total: number | null;
}

/** Drives download+install, reporting progress via `onProgress`. */
export async function downloadAndInstallUpdate(
    update: UpdateInfo,
    onProgress: (progress: UpdateProgress) => void,
): Promise<void> {
    let downloaded = 0;
    let total: number | null = null;
    onProgress({ phase: 'downloading', downloaded, total });
    await update.downloadAndInstall((event) => {
        switch (event.event) {
            case 'Started':
                total = event.data.contentLength ?? null;
                onProgress({ phase: 'downloading', downloaded, total });
                break;
            case 'Progress':
                downloaded += event.data.chunkLength;
                onProgress({ phase: 'downloading', downloaded, total });
                break;
            case 'Finished':
                onProgress({ phase: 'ready', downloaded, total });
                break;
        }
    });
}

export async function restartToApplyUpdate(): Promise<void> {
    await relaunch();
}

/**
 * Fake `UpdateInfo` for exercising the update UI without a real Tauri
 * runtime to check against (`pnpm run dev`) or with `VITE_STUB_UPDATE` set
 * (`pnpm run dev:stub`). `downloadAndInstall` fires the same
 * `Started` → `Progress`(xN) → `Finished` event sequence the real plugin
 * would, on a short timer.
 */
export function createMockUpdate(info: {
    version: string;
    currentVersion: string;
    body?: string;
}): UpdateInfo {
    return {
        ...info,
        async downloadAndInstall(onEvent) {
            const total = 2_000_000;
            const chunk = 400_000;
            onEvent?.({ event: 'Started', data: { contentLength: total } });
            for (let sent = 0; sent < total; sent += chunk) {
                await new Promise((resolve) => setTimeout(resolve, 150));
                onEvent?.({
                    event: 'Progress',
                    data: { chunkLength: Math.min(chunk, total - sent) },
                });
            }
            onEvent?.({ event: 'Finished' });
        },
    };
}
