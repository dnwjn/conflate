import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mountApp, showUpdateModal, windowTitleFor, wireUpdateUi } from './app';
import { makeHunk } from './merge/testHunks';
import { createMockUpdate } from './update';

const input = {
    base: 'a\n',
    local: 'L\n',
    remote: 'R\n',
    languageHint: null,
    fileName: 'pricing.rs',
    fullPath: '/repo/sub/pricing.rs',
};
const mergeResult = {
    auto_merged_text: 'L\n',
    conflict_count: 1,
    hunks: [
        makeHunk({
            start_line: 0,
            end_line: 1,
            kind: 'Conflict',
            base_text: 'a\n',
            local_text: 'L\n',
            remote_text: 'R\n',
            merged_text: 'L\n',
        }),
    ],
};

// jsdom has no layout: CodeMirror's scroll-into-view measurement (used when
// the app focuses the first conflict) calls Range#getClientRects, which
// jsdom doesn't implement. Stub it so measurement degrades to zero rects.
if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect();
}

let root: HTMLElement;
beforeEach(() => {
    clearMocks();
    root = document.createElement('div');
    document.body.appendChild(root);
});
afterEach(() => {
    document.body.innerHTML = '';
});

function mockBackend(
    overrides: Record<string, (args: unknown) => unknown> = {},
) {
    const calls: { cmd: string; args: unknown }[] = [];
    mockIPC((cmd, args) => {
        calls.push({ cmd, args });
        if (overrides[cmd]) return overrides[cmd](args);
        if (cmd === 'get_merge_input') return input;
        if (cmd === 'compute_three_way_merge_command') return mergeResult;
        if (cmd === 'compute_word_diff_command') return [];
        return null;
    });
    return calls;
}

test('an internal-invariant rejection from compute_three_way_merge shows an error state, not a crash', async () => {
    mockBackend({
        compute_three_way_merge_command: () =>
            Promise.reject('invariant violated: hunks do not tile'),
    });
    await expect(mountApp(root)).resolves.not.toBeNull();
    expect(root.querySelector('.error-state')?.textContent).toContain(
        'invariant violated',
    );
    expect(
        root.querySelector<HTMLButtonElement>('#save-button')!.disabled,
    ).toBe(true);
    expect(
        root.querySelector<HTMLButtonElement>('#abort-button')!.disabled,
    ).toBe(false);
    expect(root.querySelector('.tw-pane')).toBeNull();
});

test('a malformed merge result (hunk past end of doc) shows an error state instead of throwing', async () => {
    mockBackend({
        compute_three_way_merge_command: () => ({
            ...mergeResult,
            hunks: [makeHunk({ start_line: 0, end_line: 9, kind: 'Conflict' })],
        }),
    });
    await expect(mountApp(root)).resolves.not.toBeNull();
    expect(root.querySelector('.error-state')).not.toBeNull();
});

test('LOCAL/REMOTE panes show branch names from the backend when available', async () => {
    mockBackend({
        get_merge_input: () => ({
            ...input,
            localBranch: 'feature/pricing',
            remoteBranch: 'main',
        }),
    });
    await mountApp(root);
    expect(root.querySelector('.tw-pane-local .tw-pane-sub')?.textContent).toBe(
        '· feature/pricing',
    );
    expect(
        root.querySelector('.tw-pane-remote .tw-pane-sub')?.textContent,
    ).toBe('· main');
});

test("LOCAL falls back to 'HEAD' and REMOTE shows nothing when branch detection fails", async () => {
    mockBackend(); // default fixture: no localBranch/remoteBranch
    await mountApp(root);
    expect(root.querySelector('.tw-pane-local .tw-pane-sub')?.textContent).toBe(
        '· HEAD',
    );
    expect(
        root.querySelector('.tw-pane-remote .tw-pane-sub')?.textContent,
    ).toBe('');
});

test("notifyUpdateFound marks the version button's dot, however the caller learned about the update (not just an in-app click)", async () => {
    mockBackend();
    const app = await mountApp(root);
    const versionButton =
        root.querySelector<HTMLButtonElement>('.brand-version')!;
    expect(versionButton.classList.contains('has-update')).toBe(false);

    app.notifyUpdateFound(
        createMockUpdate({ version: '0.2.0', currentVersion: '0.1.0' }),
    );

    expect(versionButton.classList.contains('has-update')).toBe(true);
});

test('Save with unresolved conflicts asks first; cancel does not save, confirm saves with force', async () => {
    const calls = mockBackend();
    await mountApp(root);
    expect(root.querySelectorAll('.tw-pane')).toHaveLength(3);
    expect(root.querySelector('#app-message')?.textContent).toBe(
        '1 conflict remaining',
    );

    root.querySelector<HTMLButtonElement>('#save-button')!.click();
    await vi.waitFor(() =>
        expect(root.querySelector('.modal-card')).not.toBeNull(),
    );
    root.querySelector<HTMLButtonElement>('[data-action="cancel"]')!.click();
    await Promise.resolve();
    expect(calls.some((c) => c.cmd === 'save_result')).toBe(false);

    root.querySelector<HTMLButtonElement>('#save-button')!.click();
    await vi.waitFor(() =>
        expect(root.querySelector('.modal-card')).not.toBeNull(),
    );
    root.querySelector<HTMLButtonElement>('[data-action="confirm"]')!.click();
    await vi.waitFor(() =>
        expect(calls.some((c) => c.cmd === 'save_result')).toBe(true),
    );
    expect(calls.find((c) => c.cmd === 'save_result')!.args).toEqual({
        content: 'L\n',
        unresolvedCount: 1,
        force: true,
    });
});

test('Save with everything resolved saves without asking and without force', async () => {
    const calls = mockBackend();
    await mountApp(root);
    (root.querySelector('.cm-pull-remote') as HTMLElement).click();
    expect(root.querySelector('#app-message')?.textContent).toBe(
        'All conflicts resolved',
    );
    // Nothing left to jump between or auto-merge once everything is resolved.
    expect(root.querySelector('.conflict-counter')?.textContent).toBe(
        'All resolved',
    );
    expect(
        root.querySelector<HTMLButtonElement>('#abort-button')!.disabled,
    ).toBe(false); // sanity: not globally disabled
    expect(
        root.querySelector<HTMLButtonElement>('[title^="Previous conflict"]')!
            .disabled,
    ).toBe(true);
    expect(
        root.querySelector<HTMLButtonElement>('[title^="Next conflict"]')!
            .disabled,
    ).toBe(true);
    root.querySelector<HTMLButtonElement>('#save-button')!.click();
    await vi.waitFor(() =>
        expect(calls.some((c) => c.cmd === 'save_result')).toBe(true),
    );
    expect(root.querySelector('.modal-card')).toBeNull();
    expect(calls.find((c) => c.cmd === 'save_result')!.args).toEqual({
        content: 'R\n',
        unresolvedCount: 0,
        force: false,
    });
});

test('a rejected save_result is reported in the status bar', async () => {
    mockBackend({
        save_result: () => Promise.reject('cannot write merged file'),
    });
    await mountApp(root);
    (root.querySelector('.cm-pull-local') as HTMLElement).click();
    root.querySelector<HTMLButtonElement>('#save-button')!.click();
    await vi.waitFor(() =>
        expect(root.querySelector('#app-message')?.textContent).toContain(
            'cannot write merged file',
        ),
    );
    expect(
        root.querySelector<HTMLButtonElement>('#save-button')!.disabled,
    ).toBe(false);
});

test('Abort asks for confirmation before calling abort_merge', async () => {
    const calls = mockBackend();
    await mountApp(root);
    root.querySelector<HTMLButtonElement>('#abort-button')!.click();
    await vi.waitFor(() =>
        expect(root.querySelector('.modal-card')).not.toBeNull(),
    );
    expect(calls.some((c) => c.cmd === 'abort_merge')).toBe(false);
    root.querySelector<HTMLButtonElement>('[data-action="confirm"]')!.click();
    await vi.waitFor(() =>
        expect(calls.some((c) => c.cmd === 'abort_merge')).toBe(true),
    );
});

// Delete-vs-modify: local deleted "b", remote changed it to "B" -> a
// ZERO-WIDTH conflict (index 1) immediately followed by an Unchanged hunk
// (index 2) starting at the same result offset; plus a normal conflict
// (index 3). Pinned on the Rust side by
// `delete_vs_modify_fixture_has_zero_width_conflict_then_unchanged_at_same_line`.
const deleteVsModifyInput = {
    base: 'a\nb\nc\nd\n',
    local: 'a\nc\nD1\n',
    remote: 'a\nB\nc\nD2\n',
    languageHint: null,
    fileName: 'doc.txt',
    fullPath: '/repo/doc.txt',
};
const deleteVsModifyResult = {
    auto_merged_text: 'a\nc\nD1\n',
    conflict_count: 2,
    hunks: [
        makeHunk({
            start_line: 0,
            end_line: 1,
            kind: 'Unchanged',
            local_text: 'a\n',
            remote_text: 'a\n',
            merged_text: 'a\n',
        }),
        makeHunk({
            start_line: 1,
            end_line: 1,
            kind: 'Conflict',
            local_start_line: 1,
            local_end_line: 1,
            remote_start_line: 1,
            remote_end_line: 2,
            base_text: 'b\n',
            local_text: '',
            remote_text: 'B\n',
        }),
        makeHunk({
            start_line: 1,
            end_line: 2,
            kind: 'Unchanged',
            local_start_line: 1,
            local_end_line: 2,
            remote_start_line: 2,
            remote_end_line: 3,
            local_text: 'c\n',
            remote_text: 'c\n',
            merged_text: 'c\n',
        }),
        makeHunk({
            start_line: 2,
            end_line: 3,
            kind: 'Conflict',
            local_start_line: 2,
            local_end_line: 3,
            remote_start_line: 3,
            remote_end_line: 4,
            base_text: 'd\n',
            local_text: 'D1\n',
            remote_text: 'D2\n',
            merged_text: 'D1\n',
        }),
    ],
};

function press(code: string) {
    window.dispatchEvent(
        new KeyboardEvent('keydown', {
            code,
            metaKey: true,
            altKey: true,
            cancelable: true,
        }),
    );
}

function resultText(): string {
    return root.querySelector('.tw-pane-result .cm-content')!.textContent ?? '';
}

test('keyboard accept targets a zero-width (delete-vs-modify) conflict the cursor sits on', async () => {
    mockBackend({
        get_merge_input: () => deleteVsModifyInput,
        compute_three_way_merge_command: () => deleteVsModifyResult,
    });
    await mountApp(root);
    // The app focuses the first conflict on load: the zero-width one.
    expect(root.querySelector('.conflict-counter')?.textContent).toBe(
        'Conflict 1 of 2',
    );
    press('ArrowRight'); // ⌥⌘→ accept remote
    expect(root.querySelector('#app-message')?.textContent).toBe(
        '1 conflict remaining',
    );
    expect(resultText()).toContain('B');
});

test('keyboard previous/next navigation does not get stuck on a zero-width conflict', async () => {
    mockBackend({
        get_merge_input: () => deleteVsModifyInput,
        compute_three_way_merge_command: () => deleteVsModifyResult,
    });
    await mountApp(root);
    const counter = () => root.querySelector('.conflict-counter')?.textContent;
    expect(counter()).toBe('Conflict 1 of 2');
    press('Period'); // ⌥⌘. next
    expect(counter()).toBe('Conflict 2 of 2');
    press('Comma'); // ⌥⌘, previous
    expect(counter()).toBe('Conflict 1 of 2');
    press('Comma'); // wraps around to the last conflict
    expect(counter()).toBe('Conflict 2 of 2');
});

test('the window title names the file being merged', async () => {
    mockBackend();
    const setWindowTitle = vi.fn();
    await mountApp(root, { setWindowTitle });
    expect(setWindowTitle).toHaveBeenCalledWith('pricing.rs — Conflate');
    expect(document.title).toBe('pricing.rs — Conflate');
});

test('the toolbar shows the full path of the file being merged', async () => {
    mockBackend();
    await mountApp(root, {});
    const label = root.querySelector<HTMLElement>('.toolbar-filepath')!;
    expect(label.textContent).toBe(input.fullPath);
    expect(label.title).toBe(input.fullPath);
});

test('a failing native setTitle does not break loading the merge', async () => {
    mockBackend();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await mountApp(root, {
        setWindowTitle: () => Promise.reject('no permission'),
    });
    expect(root.querySelectorAll('.tw-pane')).toHaveLength(3);
    warn.mockRestore();
});

test('outside a Tauri runtime, mountApp shows a preview banner and stub data instead of an error', async () => {
    // `@tauri-apps/api/mocks` sets `window.__TAURI_INTERNALS__ = {}` as an
    // import-time side effect (and `clearMocks` only deletes its properties,
    // not the object itself), so simulate a real plain-browser tab by
    // removing it outright rather than relying on `clearMocks`.
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown })
        .__TAURI_INTERNALS__;
    await mountApp(root);
    expect(root.querySelector('.dev-banner')?.textContent).toContain(
        'Preview mode',
    );
    expect(root.querySelectorAll('.tw-pane')).toHaveLength(3);
    expect(root.querySelector('.error-state')).toBeNull();
});

test('whitespace-only conflicts start unresolved, and the "resolve simple conflicts" button clears them', async () => {
    const whitespaceOnlyResult = {
        auto_merged_text: 'L \n',
        conflict_count: 1,
        hunks: [
            makeHunk({
                start_line: 0,
                end_line: 1,
                kind: 'Conflict',
                base_text: 'a\n',
                local_text: 'L \n',
                remote_text: ' L\n',
                merged_text: 'L \n',
            }),
        ],
    };
    mockBackend({
        compute_three_way_merge_command: () => whitespaceOnlyResult,
    });
    await mountApp(root);

    expect(root.querySelector('#app-message')?.textContent).toBe(
        '1 conflict remaining',
    );
    const resolveSimpleButton = root.querySelector<HTMLButtonElement>(
        '#resolve-simple-button',
    );
    expect(resolveSimpleButton).not.toBeNull();
    expect(resolveSimpleButton?.disabled).toBe(false);

    resolveSimpleButton?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
    );

    expect(root.querySelector('#app-message')?.textContent).toBe(
        'All conflicts resolved',
    );
    expect(resolveSimpleButton?.disabled).toBe(true);
});

test('windowTitleFor falls back to the bare app name', () => {
    expect(windowTitleFor('')).toBe('Conflate');
    expect(windowTitleFor('a.rs')).toBe('a.rs — Conflate');
});

test('wireUpdateUi stays silent when the found version was already dismissed', () => {
    const update = createMockUpdate({
        version: '0.2.0',
        currentVersion: '0.1.0',
    });
    wireUpdateUi(root, update, {
        skippedVersion: '0.2.0',
        onSkipVersion: () => {},
    });
    expect(root.querySelector('.update-banner')).toBeNull();
});

test('wireUpdateUi shows a dismissible banner for a newly-found version', () => {
    const update = createMockUpdate({
        version: '0.2.0',
        currentVersion: '0.1.0',
    });
    let skipped: string | null = null;
    wireUpdateUi(root, update, {
        skippedVersion: null,
        onSkipVersion: (v) => {
            skipped = v;
        },
    });
    const banner = root.querySelector('.update-banner');
    expect(banner?.textContent).toContain('0.2.0');

    root.querySelector<HTMLButtonElement>('[data-action="dismiss"]')!.click();
    expect(root.querySelector('.update-banner')).toBeNull();
    expect(skipped).toBe('0.2.0');
});

test("wireUpdateUi's View button opens the update modal", () => {
    const update = createMockUpdate({
        version: '0.2.0',
        currentVersion: '0.1.0',
    });
    wireUpdateUi(root, update, {
        skippedVersion: null,
        onSkipVersion: () => {},
    });
    root.querySelector<HTMLButtonElement>('[data-action="view"]')!.click();
    expect(root.querySelector('.modal-backdrop')).not.toBeNull();
    expect(root.querySelector('.modal-title')?.textContent).toBe(
        'Update available',
    );
});

test('showUpdateModal walks Update -> Downloading -> Restart to Update, then calls the injected restart', async () => {
    vi.useFakeTimers();
    const update = createMockUpdate({
        version: '0.2.0',
        currentVersion: '0.1.0',
        body: 'Fixed things.',
    });
    let restarted = false;
    showUpdateModal(root, update, {
        restart: async () => {
            restarted = true;
        },
    });

    expect(root.querySelector('.modal-body')?.textContent).toContain('0.1.0');
    expect(root.querySelector('.modal-body')?.textContent).toContain('0.2.0');
    expect(root.querySelector('.modal-body')?.textContent).toContain(
        'Fixed things.',
    );

    const actionButton = root.querySelector<HTMLButtonElement>(
        '[data-action="update"]',
    )!;
    expect(actionButton.textContent).toBe('Update');
    actionButton.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(actionButton.disabled).toBe(true);
    expect(actionButton.textContent).toContain('Downloading');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(actionButton.disabled).toBe(false);
    expect(actionButton.textContent).toBe('Restart to Update');

    actionButton.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(restarted).toBe(true);
    vi.useRealTimers();
});

test('showUpdateModal shows the full release notes body without truncating it', () => {
    const longBody = `## What's Changed\n${'* PR title\n'.repeat(60)}`;
    const update = createMockUpdate({
        version: '0.2.0',
        currentVersion: '0.1.0',
        body: longBody,
    });
    showUpdateModal(root, update);
    const notes = root.querySelector('.update-notes');
    expect(notes?.textContent).toContain("What's Changed");
    expect(notes?.querySelectorAll('li')).toHaveLength(60);
});

test('showUpdateModal recovers from a failed download instead of getting stuck on "Downloading..."', async () => {
    const update = {
        version: '0.2.0',
        currentVersion: '0.1.0',
        body: 'Notes',
        downloadAndInstall: vi
            .fn()
            .mockRejectedValue(new Error('network down')),
    };
    showUpdateModal(root, update);

    const actionButton = root.querySelector<HTMLButtonElement>(
        '[data-action="update"]',
    )!;
    const laterButton = root.querySelector<HTMLButtonElement>(
        '[data-action="later"]',
    )!;
    actionButton.click();
    expect(actionButton.disabled).toBe(true);
    expect(laterButton.disabled).toBe(true);

    await vi.waitFor(() => expect(actionButton.disabled).toBe(false));

    expect(laterButton.disabled).toBe(false);
    expect(root.querySelector('.modal-error')?.textContent).toContain(
        'network down',
    );

    // The modal must still be dismissible, and retrying must be possible.
    laterButton.click();
    expect(root.querySelector('.modal-backdrop')).toBeNull();
});
