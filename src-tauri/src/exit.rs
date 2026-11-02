/// Process exit codes, matching the git mergetool contract.
#[repr(i32)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitCode {
    /// The conflict was resolved and the merged file was written.
    Resolved = 0,
    /// The user aborted without resolving.
    Aborted = 1,
    /// Bad arguments or an unrecoverable error.
    FatalError = 2,
}

/// Prints `msg` to stderr and exits with `ExitCode::FatalError`.
pub fn fatal(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(ExitCode::FatalError as i32)
}

/// Decision for a `tauri::RunEvent::ExitRequested { code, .. }`.
///
/// `code: Some(_)` is our own `app.exit(n)` from `save_result` /
/// `abort_merge`: let it through untouched (returns `None`). `code: None` is
/// a user-initiated exit — the last window was closed (red traffic-light
/// button, ⌘W, Alt+F4) — which Tauri would otherwise turn into a plain
/// exit 0, i.e. "resolved" to git (with `trustExitCode = true`, git would
/// then `git add` a file that may still contain conflict markers). Returns
/// `Some(ExitCode::Aborted)`: the caller prevents that exit and re-exits
/// with this code instead.
pub fn exit_request_override(code: Option<i32>) -> Option<i32> {
    match code {
        Some(_) => None,
        None => Some(ExitCode::Aborted as i32),
    }
}

/// Decision for `tauri::RunEvent::Exit` (the event loop is going away),
/// given the explicit exit code recorded from an earlier
/// `ExitRequested { code: Some(_) }`, if any.
///
/// Some exits never pass through a preventable `ExitRequested` — notably
/// macOS ⌘Q / the app menu's Quit, which go straight to
/// `applicationWillTerminate` and would end the process with 0. If no
/// explicit code was recorded, nobody saved or aborted through our own
/// commands, so returns `Some(ExitCode::Aborted)`: the caller must
/// `std::process::exit` with it right away. Returns `None` when an explicit
/// code is already in flight (the runtime exits with it).
pub fn exit_code_on_loop_exit(explicit_code: Option<i32>) -> Option<i32> {
    match explicit_code {
        Some(_) => None,
        None => Some(ExitCode::Aborted as i32),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_exit_requests_pass_through_unchanged() {
        // save_result's app.exit(0) and abort_merge's app.exit(1) must not be touched.
        assert_eq!(exit_request_override(Some(ExitCode::Resolved as i32)), None);
        assert_eq!(exit_request_override(Some(ExitCode::Aborted as i32)), None);
    }

    #[test]
    fn closing_the_window_becomes_an_abort_never_exit_zero() {
        assert_eq!(exit_request_override(None), Some(ExitCode::Aborted as i32));
    }

    #[test]
    fn loop_exit_without_an_explicit_code_is_an_abort() {
        // e.g. macOS Cmd+Q, which bypasses ExitRequested entirely.
        assert_eq!(exit_code_on_loop_exit(None), Some(ExitCode::Aborted as i32));
        assert_eq!(exit_code_on_loop_exit(Some(0)), None);
        assert_eq!(exit_code_on_loop_exit(Some(1)), None);
    }

    #[test]
    fn exit_code_values_match_mergetool_contract() {
        assert_eq!(ExitCode::Resolved as i32, 0);
        assert_eq!(ExitCode::Aborted as i32, 1);
        assert_eq!(ExitCode::FatalError as i32, 2);
    }
}
