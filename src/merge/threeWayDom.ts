import type { ConflictModel } from './conflictModel';

/** Keeps a side pane usable and the result pane from being squeezed away by a drag. */
export const MIN_SIDE_PANE_WIDTH = 220;
export const MIN_RESULT_PANE_WIDTH = 240;

export interface PaneDomOptions {
    localLabel?: string;
    remoteLabel?: string;
    /** Persisted LOCAL/REMOTE pane widths (CSS px) to restore on mount. Falls back to the CSS default (400px) when omitted. */
    paneWidths?: { local: number; remote: number };
    /** Called once a divider drag ends, with the new LOCAL/REMOTE pane widths (CSS px), so the caller can persist them. */
    onPaneWidthsChange?: (widths: { local: number; remote: number }) => void;
}

export interface PaneParts {
    root: HTMLElement;
    header: HTMLElement;
    editor: HTMLElement;
}

export interface DividerParts {
    divider: HTMLElement;
    svg: SVGSVGElement;
}

export interface PaneDom {
    panes: HTMLElement;
    localPane: PaneParts;
    resultPane: PaneParts;
    remotePane: PaneParts;
    localDividerParts: DividerParts;
    remoteDividerParts: DividerParts;
    unresolvedPill: HTMLSpanElement;
}

/**
 * Builds the 3-pane skeleton (LOCAL/RESULT/REMOTE sections, both resize
 * dividers, and the unresolved-count pill) and mounts it into `container`.
 * Pure DOM — doesn't know about CodeMirror, hunks, or any merge state.
 */
export function buildPaneSkeleton(
    container: HTMLElement,
    options: PaneDomOptions,
): PaneDom {
    container.classList.add('tw-root');
    const panes = document.createElement('div');
    panes.className = 'tw-panes';
    const makePane = (
        kind: 'local' | 'result' | 'remote',
        label: string,
        sub: string,
    ): PaneParts => {
        const pane = document.createElement('section');
        pane.className = `tw-pane tw-pane-${kind}`;
        const header = document.createElement('header');
        header.className = 'tw-pane-header';
        const dot = document.createElement('span');
        dot.className = 'tw-dot';
        const name = document.createElement('span');
        name.className = 'tw-pane-label';
        name.textContent = label;
        const subLabel = document.createElement('span');
        subLabel.className = 'tw-pane-sub';
        subLabel.textContent = sub ? `· ${sub}` : '';
        header.append(dot, name, subLabel);
        const editor = document.createElement('div');
        editor.className = 'tw-editor';
        pane.append(header, editor);
        panes.appendChild(pane);
        return { root: pane, header, editor };
    };
    const makeDivider = (resizes: 'local' | 'remote'): DividerParts => {
        const divider = document.createElement('div');
        divider.className = 'tw-divider';
        const spacer = document.createElement('div');
        spacer.className = 'tw-divider-spacer';
        const body = document.createElement('div');
        body.className = 'tw-divider-body';
        const svg = document.createElementNS(
            'http://www.w3.org/2000/svg',
            'svg',
        );
        svg.setAttribute('class', 'tw-connector-svg');
        body.appendChild(svg);
        divider.append(spacer, body);
        divider.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            // A ribbon connector owns its own click-to-navigate; don't start
            // a resize drag when the pointer came down on one.
            if (event.target instanceof SVGPathElement) return;
            event.preventDefault();
            const pane = (resizes === 'local' ? localPane : remotePane).root;
            const startX = event.clientX;
            const startWidth = pane.getBoundingClientRect().width;
            const containerWidth = panes.getBoundingClientRect().width;
            const otherSideWidth = (
                resizes === 'local' ? remotePane : localPane
            ).root.getBoundingClientRect().width;
            const dividerWidths =
                localDividerParts.divider.getBoundingClientRect().width +
                remoteDividerParts.divider.getBoundingClientRect().width;
            const maxWidth = Math.max(
                MIN_SIDE_PANE_WIDTH,
                containerWidth -
                    otherSideWidth -
                    dividerWidths -
                    MIN_RESULT_PANE_WIDTH,
            );
            // Both side panes have `flex-shrink: 1` at rest (so they shrink
            // together with RESULT on a narrow window — see the `.tw-panes`
            // comment in styles.css), but that same shrink is what makes the
            // divider lag the cursor during a drag: whenever a reflow needs
            // to shrink anything, the browser spreads it across all three
            // flex items instead of just RESULT, so the rendered width ends
            // up less than the `flexBasis` set below. Pinning shrink to 0 on
            // both side panes for the duration of the drag makes RESULT (and
            // only RESULT) absorb that pressure, which is what the `maxWidth`
            // clamp above already assumes.
            localPane.root.classList.add('tw-pane-dragging');
            remotePane.root.classList.add('tw-pane-dragging');
            divider.setPointerCapture(event.pointerId);
            const onMove = (moveEvent: PointerEvent) => {
                const delta = moveEvent.clientX - startX;
                const signedDelta = resizes === 'local' ? delta : -delta;
                const width = Math.min(
                    maxWidth,
                    Math.max(MIN_SIDE_PANE_WIDTH, startWidth + signedDelta),
                );
                pane.style.flexBasis = `${width}px`;
            };
            const onUp = () => {
                divider.removeEventListener('pointermove', onMove);
                divider.removeEventListener('pointerup', onUp);
                localPane.root.classList.remove('tw-pane-dragging');
                remotePane.root.classList.remove('tw-pane-dragging');
                options.onPaneWidthsChange?.({
                    local: localPane.root.getBoundingClientRect().width,
                    remote: remotePane.root.getBoundingClientRect().width,
                });
            };
            divider.addEventListener('pointermove', onMove);
            divider.addEventListener('pointerup', onUp);
        });
        divider.addEventListener('dblclick', () => {
            const pane = (resizes === 'local' ? localPane : remotePane).root;
            pane.style.flexBasis = '';
            options.onPaneWidthsChange?.({
                local: localPane.root.getBoundingClientRect().width,
                remote: remotePane.root.getBoundingClientRect().width,
            });
        });
        return { divider, svg };
    };
    const localPane = makePane('local', 'LOCAL', options.localLabel ?? 'HEAD');
    if (options.paneWidths)
        localPane.root.style.flexBasis = `${options.paneWidths.local}px`;
    const localDividerParts = makeDivider('local');
    panes.appendChild(localDividerParts.divider);
    const resultPane = makePane('result', 'RESULT', 'editable');
    const remoteDividerParts = makeDivider('remote');
    panes.appendChild(remoteDividerParts.divider);
    const remotePane = makePane('remote', 'REMOTE', options.remoteLabel ?? '');
    if (options.paneWidths)
        remotePane.root.style.flexBasis = `${options.paneWidths.remote}px`;
    const unresolvedPill = document.createElement('span');
    unresolvedPill.className = 'tw-unresolved-pill';
    resultPane.header.appendChild(unresolvedPill);
    container.appendChild(panes);

    return {
        panes,
        localPane,
        resultPane,
        remotePane,
        localDividerParts,
        remoteDividerParts,
        unresolvedPill,
    };
}

export function updateHeader(
    conflictModel: ConflictModel,
    unresolvedPill: HTMLSpanElement,
): void {
    const unresolved = conflictModel.unresolvedCount();
    unresolvedPill.textContent =
        unresolved === 0 ? 'all resolved' : `${unresolved} unresolved`;
    unresolvedPill.classList.toggle(
        'tw-unresolved-pill-done',
        unresolved === 0,
    );
}
