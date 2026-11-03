import { expect, test, vi } from 'vitest';
import {
    installKeymap,
    KEYMAP_BINDINGS,
    type KeymapActionName,
    matchBinding,
} from './keymap';

function keyEvent(
    init: Partial<KeyboardEvent> & { code?: string; key?: string },
): KeyboardEvent {
    return new KeyboardEvent('keydown', {
        code: init.code,
        key: init.key ?? '',
        metaKey: init.metaKey ?? false,
        ctrlKey: init.ctrlKey ?? false,
        altKey: init.altKey ?? false,
        shiftKey: init.shiftKey ?? false,
        cancelable: true,
    });
}

test('every binding in the help table is recognized by matchBinding and vice versa', () => {
    const tableActions = new Set(KEYMAP_BINDINGS.map((b) => b.action));
    const matcherActions: Record<string, boolean> = {
        nextConflict:
            matchBinding(
                keyEvent({ code: 'Period', metaKey: true, altKey: true }),
            ) === 'nextConflict',
        prevConflict:
            matchBinding(
                keyEvent({ code: 'Comma', metaKey: true, altKey: true }),
            ) === 'prevConflict',
        acceptLocal:
            matchBinding(
                keyEvent({ code: 'ArrowLeft', metaKey: true, altKey: true }),
            ) === 'acceptLocal',
        acceptRemote:
            matchBinding(
                keyEvent({ code: 'ArrowRight', metaKey: true, altKey: true }),
            ) === 'acceptRemote',
        acceptBoth:
            matchBinding(
                keyEvent({ code: 'ArrowDown', metaKey: true, altKey: true }),
            ) === 'acceptBoth',
        undo:
            matchBinding(keyEvent({ code: 'KeyZ', metaKey: true })) === 'undo',
        redo:
            matchBinding(
                keyEvent({ code: 'KeyZ', metaKey: true, shiftKey: true }),
            ) === 'redo',
        save:
            matchBinding(keyEvent({ code: 'KeyS', metaKey: true })) === 'save',
        abort:
            matchBinding(keyEvent({ code: 'KeyW', metaKey: true })) === 'abort',
        toggleWordDiff:
            matchBinding(
                keyEvent({ code: 'KeyH', metaKey: true, altKey: true }),
            ) === 'toggleWordDiff',
        toggleTheme:
            matchBinding(
                keyEvent({ code: 'KeyT', metaKey: true, altKey: true }),
            ) === 'toggleTheme',
        showHelp: matchBinding(keyEvent({ key: '?' })) === 'showHelp',
    };
    for (const action of tableActions)
        expect(
            matcherActions[action],
            `binding table entry "${action}" has no matcher case`,
        ).toBe(true);
    for (const [action, matched] of Object.entries(matcherActions)) {
        expect(
            tableActions.has(action as KeymapActionName),
            `matcher case "${action}" is missing from the help table`,
        ).toBe(true);
        expect(matched).toBe(true);
    }
});

test('ctrl is accepted as an alternative to cmd (non-macOS)', () => {
    expect(matchBinding(keyEvent({ code: 'KeyS', ctrlKey: true }))).toBe(
        'save',
    );
});

test('plain arrow keys without the chord do nothing', () => {
    expect(matchBinding(keyEvent({ code: 'ArrowLeft' }))).toBeNull();
    expect(
        matchBinding(keyEvent({ code: 'ArrowLeft', metaKey: true })),
    ).toBeNull(); // missing ⌥
});

test('⌘⇧S (a different chord) is not mistaken for Save', () => {
    expect(
        matchBinding(keyEvent({ code: 'KeyS', metaKey: true, shiftKey: true })),
    ).toBeNull();
});

test('installKeymap dispatches the matched action and prevents default', () => {
    const actions = {
        nextConflict: vi.fn(),
        prevConflict: vi.fn(),
        acceptLocal: vi.fn(),
        acceptRemote: vi.fn(),
        acceptBoth: vi.fn(),
        save: vi.fn(),
        abort: vi.fn(),
        toggleWordDiff: vi.fn(),
        toggleTheme: vi.fn(),
        showHelp: vi.fn(),
        undo: vi.fn(),
        redo: vi.fn(),
    };
    const listeners: ((event: Event) => void)[] = [];
    const fakeTarget = {
        addEventListener: (
            _type: string,
            listener: EventListenerOrEventListenerObject,
        ) => {
            listeners.push(listener as (event: Event) => void);
        },
        removeEventListener: (
            _type: string,
            listener: EventListenerOrEventListenerObject,
        ) => {
            const index = listeners.indexOf(listener as (event: Event) => void);
            if (index >= 0) listeners.splice(index, 1);
        },
    };

    const uninstall = installKeymap(
        actions,
        fakeTarget as unknown as typeof window,
    );
    expect(listeners).toHaveLength(1);

    const event = keyEvent({ code: 'KeyS', metaKey: true });
    const preventDefault = vi.spyOn(event, 'preventDefault');
    listeners[0](event);
    expect(actions.save).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalled();

    listeners[0](keyEvent({ code: 'Period', metaKey: true, altKey: true }));
    expect(actions.nextConflict).toHaveBeenCalledTimes(1);

    // Unrecognized event: no action fires, nothing throws.
    listeners[0](keyEvent({ code: 'KeyZ' }));
    for (const spy of Object.values(actions))
        expect(spy).not.toHaveBeenCalledTimes(2);

    uninstall();
    expect(listeners).toHaveLength(0);
});

test("showHelp (?) is suppressed while focus is inside a CM6 editor or a text input, so typing '?' still works", () => {
    const actions = { showHelp: vi.fn() } as unknown as Parameters<
        typeof installKeymap
    >[0];
    const cmContent = document.createElement('div');
    cmContent.className = 'cm-content';
    cmContent.contentEditable = 'true';
    document.body.appendChild(cmContent);
    const input = document.createElement('input');
    document.body.appendChild(input);
    const plainDiv = document.createElement('div');
    document.body.appendChild(plainDiv);

    let handler: ((event: Event) => void) | null = null;
    const fakeTarget = {
        addEventListener: (
            _type: string,
            listener: EventListenerOrEventListenerObject,
        ) => {
            handler = listener as (event: Event) => void;
        },
        removeEventListener: () => {},
    };
    installKeymap(actions, fakeTarget as unknown as typeof window);

    const fire = (target: HTMLElement) => {
        const event = keyEvent({ key: '?' });
        Object.defineProperty(event, 'target', { value: target });
        handler!(event);
    };

    fire(cmContent);
    fire(input);
    expect(actions.showHelp).not.toHaveBeenCalled();

    fire(plainDiv);
    expect(actions.showHelp).toHaveBeenCalledTimes(1);

    document.body.innerHTML = '';
});
