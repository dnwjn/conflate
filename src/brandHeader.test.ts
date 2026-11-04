import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { beforeEach, expect, test, vi } from 'vitest';
import packageJson from '../package.json';
import { buildBrandHeader, createUpdateChecker } from './brandHeader';

function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
    clearMocks();
});

test('buildBrandHeader renders the mark, name, and versioned button', () => {
    const { toolbar, versionButton } = buildBrandHeader();
    expect(toolbar.querySelector('.brand-mark')).not.toBeNull();
    expect(toolbar.querySelector('.brand-name')?.textContent).toBe('Conflate');
    expect(versionButton.textContent).toBe(`v${packageJson.version}`);
    expect(versionButton.classList.contains('brand-version')).toBe(true);
});

test('clicking the version button checks for an update and reports it found', async () => {
    mockIPC((cmd) => {
        if (cmd === 'plugin:updater|check') {
            return {
                rid: 1,
                currentVersion: packageJson.version,
                version: '99.0.0',
                body: '',
                rawJson: {},
            };
        }
        return null;
    });
    const { versionButton } = buildBrandHeader();
    const setStatus = vi.fn();
    const onUpdateFound = vi.fn();
    createUpdateChecker({
        versionButton,
        devMode: false,
        setStatus,
        onUpdateFound,
    });

    versionButton.click();
    await flush();

    expect(onUpdateFound).toHaveBeenCalledWith(
        expect.objectContaining({ version: '99.0.0' }),
    );
    expect(versionButton.classList.contains('has-update')).toBe(true);
});

test('clicking the version button reports up to date when no update is found', async () => {
    mockIPC((cmd) => {
        if (cmd === 'plugin:updater|check') return null;
        return null;
    });
    const { versionButton } = buildBrandHeader();
    const setStatus = vi.fn();
    createUpdateChecker({
        versionButton,
        devMode: false,
        setStatus,
        onUpdateFound: vi.fn(),
    });

    versionButton.click();
    await flush();

    expect(setStatus).toHaveBeenCalledWith(
        `Up to date (v${packageJson.version})`,
        'ok',
    );
});

test('a second click reopens the already-found update instead of checking again', async () => {
    let checkCalls = 0;
    mockIPC((cmd) => {
        if (cmd === 'plugin:updater|check') {
            checkCalls += 1;
            return {
                rid: 1,
                currentVersion: packageJson.version,
                version: '99.0.0',
                body: '',
                rawJson: {},
            };
        }
        return null;
    });
    const { versionButton } = buildBrandHeader();
    const onUpdateFound = vi.fn();
    createUpdateChecker({
        versionButton,
        devMode: false,
        setStatus: vi.fn(),
        onUpdateFound,
    });

    versionButton.click();
    await flush();
    versionButton.click();
    await Promise.resolve();

    expect(checkCalls).toBe(1);
    expect(onUpdateFound).toHaveBeenCalledTimes(2);
});

test('devMode suppresses the check entirely', async () => {
    const spy = vi.fn();
    mockIPC((cmd) => {
        if (cmd === 'plugin:updater|check') spy();
        return null;
    });
    const { versionButton } = buildBrandHeader();
    createUpdateChecker({
        versionButton,
        devMode: true,
        setStatus: vi.fn(),
        onUpdateFound: vi.fn(),
    });

    versionButton.click();
    await Promise.resolve();

    expect(spy).not.toHaveBeenCalled();
});

test('notifyUpdateFound (e.g. from a background check) also sets the has-update dot', () => {
    const { versionButton } = buildBrandHeader();
    const checker = createUpdateChecker({
        versionButton,
        devMode: false,
        setStatus: vi.fn(),
        onUpdateFound: vi.fn(),
    });
    checker.notifyUpdateFound({
        version: '1.2.3',
        currentVersion: '1.0.0',
        downloadAndInstall: vi.fn(),
    });
    expect(versionButton.classList.contains('has-update')).toBe(true);
});
