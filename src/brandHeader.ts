import packageJson from '../package.json';
import brandMarkIcon from './assets/icons/brand-mark.svg?raw';
import { checkForUpdate, type UpdateInfo } from './update';

export interface BrandHeader {
    toolbar: HTMLElement;
    versionButton: HTMLButtonElement;
}

/**
 * Builds the `<header class="toolbar">` brand section (mark, "Conflate"
 * name, version button) shared by the real merge view and the empty-state
 * screen. The toolbar element is returned so a caller (`mountApp`) can
 * append further, merge-specific controls onto the same element; a caller
 * with nothing more to add (the empty state) can use it as-is.
 */
export function buildBrandHeader(): BrandHeader {
    const toolbar = el('header', 'toolbar');
    const brand = el('div', 'toolbar-brand');
    const versionButton = button(
        `v${packageJson.version}`,
        'brand-version',
        'Check for updates',
    );
    const brandMark = el('span', 'brand-mark');
    brandMark.innerHTML = brandMarkIcon;
    brand.append(
        brandMark,
        el('span', 'brand-name', 'Conflate'),
        versionButton,
    );
    toolbar.append(brand);
    return { toolbar, versionButton };
}

export interface UpdateChecker {
    /** Marks an update as found regardless of which path discovered it (an in-app check or a caller-driven background check). */
    notifyUpdateFound(update: UpdateInfo): void;
    /** Explicit, non-silent check (unlike a background check, this always says something, even "up to date"). */
    checkNow(): Promise<void>;
}

/**
 * Wires a brand header's version button to a check-for-updates flow, shared
 * by the real merge view and the empty-state screen so both get the same
 * "has-update" dot and modal behavior from one implementation.
 */
export function createUpdateChecker(options: {
    versionButton: HTMLButtonElement;
    devMode: boolean;
    setStatus: (text: string, tone: 'ok' | 'pending' | 'error') => void;
    /** Called with the found update, found via either a click or `notifyUpdateFound`; the caller shows it (e.g. `showUpdateModal`). */
    onUpdateFound: (update: UpdateInfo) => void;
}): UpdateChecker {
    let foundUpdate: UpdateInfo | null = null;

    function notifyUpdateFound(update: UpdateInfo) {
        foundUpdate = update;
        options.versionButton.classList.add('has-update');
    }

    async function checkNow() {
        if (options.devMode) return;
        if (foundUpdate) {
            options.onUpdateFound(foundUpdate);
            return;
        }
        options.versionButton.disabled = true;
        options.setStatus('Checking for updates...', 'pending');
        const update = await checkForUpdate();
        options.versionButton.disabled = false;
        if (update) {
            notifyUpdateFound(update);
            options.onUpdateFound(update);
        } else {
            options.setStatus(`Up to date (v${packageJson.version})`, 'ok');
        }
    }

    options.versionButton.addEventListener('click', () => void checkNow());

    return { notifyUpdateFound, checkNow };
}

function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function button(
    text: string,
    className: string,
    title?: string,
): HTMLButtonElement {
    const node = el('button', className, text);
    node.type = 'button';
    if (title) {
        node.title = title;
        node.setAttribute('aria-label', title);
    }
    return node;
}
