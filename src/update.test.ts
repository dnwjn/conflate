import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
    checkForUpdate,
    createMockUpdate,
    downloadAndInstallUpdate,
    type UpdateProgress,
} from './update';

beforeEach(() => {
    clearMocks();
});

afterEach(() => {
    vi.unstubAllEnvs();
});

test('checkForUpdate returns the update metadata when one is found', async () => {
    mockIPC((cmd) => {
        if (cmd === 'plugin:updater|check') {
            return {
                rid: 1,
                currentVersion: '0.1.0',
                version: '0.2.0',
                body: 'Release notes',
                rawJson: {},
            };
        }
        return null;
    });

    const update = await checkForUpdate();

    expect(update).toMatchObject({ version: '0.2.0', currentVersion: '0.1.0' });
});

test('checkForUpdate resolves to null instead of throwing when the check fails (no runtime, network error)', async () => {
    mockIPC(() => {
        throw new Error('no runtime');
    });

    await expect(checkForUpdate()).resolves.toBeNull();
});

test('checkForUpdate returns a stubbed update without touching the IPC bridge when VITE_STUB_UPDATE is set', async () => {
    vi.stubEnv('VITE_STUB_UPDATE', '1');
    mockIPC(() => {
        throw new Error('should never be called in stub mode');
    });

    const update = await checkForUpdate();

    expect(update).not.toBeNull();
    expect(update?.version).not.toBe(update?.currentVersion);
});

test('downloadAndInstallUpdate translates download events into progress states', async () => {
    const events: UpdateProgress[] = [];
    const update = createMockUpdate({
        version: '0.2.0',
        currentVersion: '0.1.0',
        body: 'Notes',
    });

    await downloadAndInstallUpdate(update, (p) => events.push(p));

    expect(events[0]).toMatchObject({ phase: 'downloading', downloaded: 0 });
    expect(events[events.length - 1]).toMatchObject({ phase: 'ready' });
    expect(
        events.some((e) => e.phase === 'downloading' && e.downloaded! > 0),
    ).toBe(true);
});
