/**
 * Conflate's global keyboard shortcut table.
 *
 * Installed as a single `window`-level `keydown` listener (capture phase)
 * rather than a CM6 `keymap` facet: several bindings (Save, Abort, next/prev
 * conflict) have to work even when focus is outside any CM6 editor instance
 * (e.g. on a toolbar button, or nothing focused at all), which a CM6 facet
 * alone cannot provide. This absorbs the ad-hoc `window` keydown listener
 * Task 10 added inline in `app.ts` for next/prev conflict and extends it
 * with the rest of the spec's binding table.
 *
 * `event.code` (not `.key`) is used for every chord: macOS remaps `.key`
 * under ⌥ (e.g. ⌥⌘. becomes "≥", ⌥⌘, becomes "≤"), so matching on the
 * physical key is what actually makes "⌥⌘." reliable.
 */

export interface KeymapActions {
    /** ⌥⌘. — move to the next unresolved conflict. */
    nextConflict(): void;
    /** ⌥⌘, — move to the previous unresolved conflict. */
    prevConflict(): void;
    /** ⌥⌘← — accept local for the currently-focused conflict. */
    acceptLocal(): void;
    /** ⌥⌘→ — accept remote for the currently-focused conflict. */
    acceptRemote(): void;
    /** ⌥⌘↓ — accept both sides for the currently-focused conflict. */
    acceptBoth(): void;
    /** ⌘S — save & finish. */
    save(): void;
    /** ⌘W — abort (goes through the existing confirm-on-abort dialog). */
    abort(): void;
    /** ⌥⌘H — toggle word-level diff highlighting. */
    toggleWordDiff(): void;
    /** ⌘Z — undo the last result-pane edit/hunk resolution. */
    undo(): void;
    /** ⇧⌘Z — redo the last undone result-pane edit/hunk resolution. */
    redo(): void;
    /** ⌥⌘T — toggle theme (stub; see `toggleTheme` binding note below). */
    toggleTheme(): void;
    /** ? — open the keyboard-shortcut help overlay. */
    showHelp(): void;
}

export type KeymapActionName = keyof KeymapActions;

export interface KeymapBinding {
    /** Human-readable key combo, as shown in the help overlay. */
    combo: string;
    /** One-line description, as shown in the help overlay. */
    description: string;
    action: KeymapActionName;
}

/**
 * The full binding table, in display order. Also drives the `?` help
 * overlay — one row per entry — so the overlay can never drift out of sync
 * with what `matchBinding` actually recognizes.
 */
export const KEYMAP_BINDINGS: readonly KeymapBinding[] = [
    { combo: '⌥⌘.', description: 'Next conflict', action: 'nextConflict' },
    { combo: '⌥⌘,', description: 'Previous conflict', action: 'prevConflict' },
    { combo: '⌥⌘←', description: 'Accept local', action: 'acceptLocal' },
    { combo: '⌥⌘→', description: 'Accept remote', action: 'acceptRemote' },
    {
        combo: '⌥⌘↓',
        description: 'Accept both (local, then remote)',
        action: 'acceptBoth',
    },
    { combo: '⌘Z', description: 'Undo', action: 'undo' },
    { combo: '⇧⌘Z', description: 'Redo', action: 'redo' },
    { combo: '⌘S', description: 'Save & finish', action: 'save' },
    { combo: '⌘W', description: 'Abort merge', action: 'abort' },
    {
        combo: '⌥⌘H',
        description: 'Toggle word-diff highlighting',
        action: 'toggleWordDiff',
    },
    { combo: '⌥⌘T', description: 'Toggle theme', action: 'toggleTheme' },
    { combo: '?', description: 'Show keyboard shortcuts', action: 'showHelp' },
];

/**
 * Pure matcher: given a keydown event, returns the action it triggers, or
 * `null` if it matches no binding. Separated from `installKeymap` so the
 * routing logic is testable without touching the DOM/`window` at all.
 */
export function matchBinding(event: KeyboardEvent): KeymapActionName | null {
    const mod = event.metaKey || event.ctrlKey;

    if (mod && event.altKey) {
        switch (event.code) {
            case 'Period':
                return 'nextConflict';
            case 'Comma':
                return 'prevConflict';
            case 'ArrowLeft':
                return 'acceptLocal';
            case 'ArrowRight':
                return 'acceptRemote';
            case 'ArrowDown':
                return 'acceptBoth';
            case 'KeyH':
                return 'toggleWordDiff';
            case 'KeyT':
                return 'toggleTheme';
            default:
                return null;
        }
    }

    if (mod && !event.altKey && event.code === 'KeyZ') {
        return event.shiftKey ? 'redo' : 'undo';
    }

    if (mod && !event.altKey && !event.shiftKey) {
        if (event.code === 'KeyS') return 'save';
        if (event.code === 'KeyW') return 'abort';
        return null;
    }

    // "?" is a bare, unmodified character key (Shift+/ on a US layout, but
    // `.key` already accounts for that) — guarded separately in
    // `installKeymap` so it doesn't steal a literal "?" typed into an editor.
    if (!mod && !event.altKey && event.key === '?') return 'showHelp';

    return null;
}

function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
        return true;
    // CM6 editors are a contenteditable `.cm-content` div; `isContentEditable`
    // above already covers a direct hit, but keydown can also land on a
    // non-editable descendant (e.g. a widget) inside one.
    return target.closest('.cm-content') !== null;
}

type EventTargetLike = Pick<
    typeof window,
    'addEventListener' | 'removeEventListener'
>;

/**
 * Installs the global keydown listener and returns a cleanup function that
 * removes it. `target` defaults to `window` and is overridable for tests.
 */
export function installKeymap(
    actions: KeymapActions,
    target: EventTargetLike = window,
): () => void {
    function onKeyDown(event: Event) {
        const keyEvent = event as KeyboardEvent;
        const action = matchBinding(keyEvent);
        if (!action) return;
        // Let a literal "?" be typed while focus is in an editor/input.
        if (action === 'showHelp' && isEditableTarget(keyEvent.target)) return;
        keyEvent.preventDefault();
        actions[action]();
    }
    target.addEventListener('keydown', onKeyDown, true);
    return () => target.removeEventListener('keydown', onKeyDown, true);
}
