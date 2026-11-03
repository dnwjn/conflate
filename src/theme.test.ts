import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
    applyThemeOverride,
    initTheme,
    nextOverride,
    resolveEffectiveTheme,
    themeAttributeFor,
    themeIndicatorIcon,
    themeIndicatorLabel,
} from './theme';

test('resolveEffectiveTheme prefers an explicit override over system preference', () => {
    expect(resolveEffectiveTheme('dark', false)).toBe('dark');
    expect(resolveEffectiveTheme('light', true)).toBe('light');
    expect(resolveEffectiveTheme('system', true)).toBe('dark');
    expect(resolveEffectiveTheme('system', false)).toBe('light');
});

test('nextOverride cycles system -> light -> dark -> system', () => {
    expect(nextOverride('system')).toBe('light');
    expect(nextOverride('light')).toBe('dark');
    expect(nextOverride('dark')).toBe('system');
});

test('themeAttributeFor: system has no attribute, light/dark map straight through', () => {
    expect(themeAttributeFor('system')).toBeNull();
    expect(themeAttributeFor('light')).toBe('light');
    expect(themeAttributeFor('dark')).toBe('dark');
});

test('themeIndicatorIcon/Label reflect the resolved theme, not just the raw override', () => {
    expect(themeIndicatorIcon('dark', false)).toBe('🌙');
    expect(themeIndicatorIcon('light', true)).toBe('☀');
    expect(themeIndicatorIcon('system', true)).toBe('◐');
    expect(themeIndicatorLabel('system', true)).toContain('dark');
    expect(themeIndicatorLabel('system', false)).toContain('light');
    expect(themeIndicatorLabel('dark', false)).toBe('Theme: dark');
});

// --- CSS-override-precedence contract --------------------------------------
//
// The actual cascade (styles.css's `:root[data-theme="dark"]` beating the
// `@media (prefers-color-scheme: dark)` block, and vice versa) is a browser
// fact, not something a jsdom unit test can execute (jsdom doesn't evaluate
// `@media` against a real OS preference). What *is* unit-testable, and
// verified here, is the half of the contract this module owns: given an
// override and (indirectly, via `resolveEffectiveTheme`) the system
// preference, the `data-theme` attribute `applyThemeOverride` puts on the
// element is exactly the one styles.css's selectors are written against.
function makeRoot(): HTMLElement {
    return document.createElement('html');
}

test('applyThemeOverride sets data-theme=dark regardless of system preference', () => {
    const root = makeRoot();
    applyThemeOverride('dark', root);
    expect(root.getAttribute('data-theme')).toBe('dark');
});

test('applyThemeOverride sets data-theme=light regardless of system preference', () => {
    const root = makeRoot();
    applyThemeOverride('light', root);
    expect(root.getAttribute('data-theme')).toBe('light');
});

test('applyThemeOverride removes data-theme for system (falls back to the live media query)', () => {
    const root = makeRoot();
    root.setAttribute('data-theme', 'dark');
    applyThemeOverride('system', root);
    expect(root.hasAttribute('data-theme')).toBe(false);
});

// --- initTheme wiring --------------------------------------------------------

function fakeMediaQueryList(
    initialMatches: boolean,
): MediaQueryList & { fire(matches: boolean): void } {
    let matches = initialMatches;
    const listeners = new Set<(ev: MediaQueryListEvent) => void>();
    return {
        get matches() {
            return matches;
        },
        media: '(prefers-color-scheme: dark)',
        onchange: null,
        addEventListener: (
            _type: string,
            cb: EventListenerOrEventListenerObject,
        ) => {
            listeners.add(cb as (ev: MediaQueryListEvent) => void);
        },
        removeEventListener: (
            _type: string,
            cb: EventListenerOrEventListenerObject,
        ) => {
            listeners.delete(cb as (ev: MediaQueryListEvent) => void);
        },
        dispatchEvent: () => true,
        addListener: () => {},
        removeListener: () => {},
        fire(next: boolean) {
            matches = next;
            for (const cb of listeners)
                cb({ matches: next } as MediaQueryListEvent);
        },
    };
}

let root: HTMLElement;
beforeEach(() => {
    root = document.createElement('html');
});
afterEach(() => {
    vi.restoreAllMocks();
});

test('initTheme applies the initial override immediately', () => {
    const mql = fakeMediaQueryList(false);
    initTheme({ initialOverride: 'dark', root, mediaQueryList: mql });
    expect(root.getAttribute('data-theme')).toBe('dark');
});

test("initTheme's setOverride/cycle update the DOM and notify onOverrideChange", () => {
    const mql = fakeMediaQueryList(false);
    const onOverrideChange = vi.fn();
    const controller = initTheme({
        initialOverride: 'system',
        root,
        mediaQueryList: mql,
        onOverrideChange,
    });

    controller.cycle();
    expect(controller.getOverride()).toBe('light');
    expect(root.getAttribute('data-theme')).toBe('light');
    expect(onOverrideChange).toHaveBeenLastCalledWith('light');

    controller.cycle();
    expect(controller.getOverride()).toBe('dark');
    expect(root.getAttribute('data-theme')).toBe('dark');

    controller.cycle();
    expect(controller.getOverride()).toBe('system');
    expect(root.hasAttribute('data-theme')).toBe(false);
});

test("a live system change only re-renders while the override is 'system'", () => {
    const mql = fakeMediaQueryList(false);
    const onEffectiveChange = vi.fn();
    const controller = initTheme({
        initialOverride: 'system',
        root,
        mediaQueryList: mql,
        onEffectiveChange,
    });
    onEffectiveChange.mockClear();

    mql.fire(true);
    expect(onEffectiveChange).toHaveBeenLastCalledWith('dark', 'system');
    expect(root.hasAttribute('data-theme')).toBe(false); // still no manual override

    controller.setOverride('light');
    onEffectiveChange.mockClear();
    mql.fire(false); // system flips back — must NOT fight the manual override
    expect(onEffectiveChange).not.toHaveBeenCalled();
    expect(root.getAttribute('data-theme')).toBe('light');
});

test('dispose stops reacting to further system changes', () => {
    const mql = fakeMediaQueryList(false);
    const onEffectiveChange = vi.fn();
    const controller = initTheme({
        initialOverride: 'system',
        root,
        mediaQueryList: mql,
        onEffectiveChange,
    });
    controller.dispose();
    onEffectiveChange.mockClear();
    mql.fire(true);
    expect(onEffectiveChange).not.toHaveBeenCalled();
});
