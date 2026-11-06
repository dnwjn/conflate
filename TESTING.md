# Manual smoke-test checklist

The 3-pane merge view (`src/merge/threeWayView.ts`) is covered by unit tests for
its pure logic and for its behaviour in jsdom. This checklist covers the parts
that need a real renderer. Run it before each release.

## Setup

Use the sample trio in `dev-fixtures/sample/` (it has a Conflict, a
delete-vs-modify zero-width Conflict, LocalOnly, RemoteOnly, SameChange, and
a one-sided insertion), or make your own with the same mix. Then run (two
`--` — see CONTRIBUTING.md for why; paths must be absolute):

```sh
pnpm run tauri dev -- -- \
  "$PWD/dev-fixtures/sample/base.ts" "$PWD/dev-fixtures/sample/local.ts" \
  "$PWD/dev-fixtures/sample/remote.ts" /tmp/conflate-merged.ts
```

The `.ts` extension exercises syntax highlighting.

**Exit-code checks** must run the app binary directly, not through
`pnpm run tauri dev` (whose own exit status is the dev server's, not
Conflate's). Build once with `pnpm run tauri build`, then:

```sh
F="$PWD/dev-fixtures/sample"
src-tauri/target/release/conflate "$F/base.ts" "$F/local.ts" "$F/remote.ts" /tmp/conflate-merged.ts; echo "exit=$?"
```

## Checklist

- [ ] Window shows the toolbar, three panes (LOCAL, RESULT · editable, REMOTE)
      with colored header dots, and the status bar.
- [ ] Syntax highlighting is active in all three panes.
- [ ] Conflict hunks have an amber band in all three panes. Auto-merged hunks
      have a green band and an "auto-merged" pill in the result.
- [ ] One-sided insertions and deletions show a thin rule where the other side
      has nothing.
- [ ] Word-level highlights appear inside line-paired conflict lines.
      Whitespace-only differences are NOT highlighted. The "Word diff" toolbar
      button toggles the highlights.
- [ ] An open conflict shows both pull arrows (← local, → remote). Clicking one
      replaces the hunk, the band turns green with a "resolved" pill, and both
      unresolved counters decrement.
- [ ] After a pull, side-pane tints update to reflect the new result. Typing in
      the result updates the tints on the next frame, and rapid typing stays
      smooth.
- [ ] ⌘Z / ⇧⌘Z undo and redo a pull, including its resolved/unresolved state.
- [ ] ⌥⌘. / ⌥⌘, cycle through unresolved conflicts, and the counter follows.
      This includes the zero-width delete-vs-modify conflict (`legacy()` in the
      sample): the counter shows its number (not "–") when it is focused, and
      ⌥⌘→ / ⌥⌘← / ⌥⌘↓ resolve it.
- [ ] Scrolling the result keeps the side panes line-aligned. The wheel over a
      side pane scrolls all three together.
- [ ] **Pull controls stay visible/clickable on wide lines (review fix,
      2026-11-02):** make one line in `merged.ts`/`local.ts`/`remote.ts`
      noticeably wider than the result pane (e.g. ~150+ characters, or resize
      the window narrower). With the result pane scrolled all the way to the
      *left* (horizontal scrollbar at the start, i.e. no scrolling yet):
      - [ ] The "accept remote" (→) arrow and the status pill (auto-merged /
            resolved) for every hunk are visible inside the pane's right edge,
            not pushed off past it — no horizontal scrolling should be needed
            to see or click them.
      - [ ] The "accept local" (←) arrow for every hunk is visible inside the
            pane's left edge.
      - [ ] Scroll the result pane horizontally (drag its horizontal
            scrollbar, or click into the long line and press End): both
            arrows and the pill stay pinned to the pane's visible edges at
            every scroll position, rather than scrolling away with the text
            underneath them.
      - [ ] Clicking → / ← while scrolled mid-line still pulls the correct
            hunk (click targets track the controls' visually pinned position,
            not their underlying un-pinned document position).
- [ ] Save & Finish with unresolved conflicts asks first. Cancel does nothing;
      "Save anyway" writes `merged.ts` and exits 0.
- [ ] Save & Finish with everything resolved writes and exits 0 without asking.
- [ ] Abort asks first, then exits 1 without writing.
- [ ] **Leaving without Save never exits 0 (final-review fix, 2026-11-02).**
      Using the direct-binary command above, `rm -f /tmp/conflate-merged.ts`
      before each run, then leave the app each of these ways and check
      `echo "exit=$?"` prints `exit=1` and `/tmp/conflate-merged.ts` was NOT
      created:
      - [ ] the red traffic-light (close) button;
      - [ ] `⌘Q` (and, separately, Conflate → Quit Conflate from the menu bar);
      - [ ] `⌘W` in the normal state (note whether the in-app Abort
            confirmation appears, or the window closes straight away via the
            native "Close Window" menu item — either is acceptable as long as
            the exit code is 1);
      - [ ] `⌘W`, the close button and `⌘Q` in the **error-load state**
            ("Can't show this merge" panel), where the in-app keymap is never
            installed. Fatal input errors now exit 2 before a window opens, so
            reaching this state needs an internal error — e.g. temporarily
            make `get_merge_input` in `src-tauri/src/commands.rs` return
            `Err("test".into())` in a local build. Expect exit 1 every time.
      Only Save & Finish may ever produce `exit=0`.
- [ ] **Binary input exits 2 with no window:** pass any binary file (e.g. a
      `.png`) as `local`; the process prints a "not valid UTF-8" error and
      exits 2 without a window ever appearing.
- [ ] **Window title** reads `<merged file name> — Conflate` (e.g.
      `conflate-merged.ts — Conflate` with the command above).
- [ ] **Window size persists without growing (Retina):** resize the window,
      quit, relaunch three times — it comes back at the same size each time
      (previously it doubled on 2x displays).
- [ ] **CRLF round-trip:** convert the sample trio to CRLF
      (`for f in base local remote; do perl -pe 's/\n/\r\n/' "$F/$f.ts" > "/tmp/crlf-$f.ts"; done`),
      run on the `/tmp/crlf-*.ts` files, resolve, save, then
      `file /tmp/conflate-merged.ts` reports "with CRLF line terminators" and
      no pane shows stray `\r` markers at line ends.
- [ ] Light and dark OS appearance both look right.

## Results log

- 2026-11-02 (Task 10): every item above checked in Chrome. The production
  frontend ran in a harness that fed the REAL Rust `compute_three_way_merge`
  output (all hunk kinds) through mocked IPC, in viewports of 1400x640 and
  1400x420 and in both color schemes. A 6,000-line file stayed responsive while typing: median 0.5 ms and
  max 4.7 ms per keystroke, no long tasks. The native window launched and stayed
  up, but its contents could not be captured from the agent session (no
  screen-recording permission). So these items still need a human pass in the
  real app: native window appearance, and process exit codes on Save/Abort.
