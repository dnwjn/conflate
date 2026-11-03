pub mod cli;
pub mod commands;
pub mod diff;
pub mod exit;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
#[specta::specta]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// The set of Tauri commands exposed to the frontend, collected once so both
/// the real app (`run`) and the TypeScript export (`export_bindings`, and the
/// `export_bindings_to_disk` test) register exactly the same commands.
fn specta_builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new()
        // Keep the plain `Result<T, String>` -> rejected-promise semantics
        // Tauri commands have by default (and that Task 4's `ipc.ts`/tests
        // already rely on): a fallible command's `Err` rejects the JS
        // promise, rather than tauri-specta's non-default "typed error"
        // wrapper that resolves to a `{status: "ok" | "error", ...}` object.
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        .commands(tauri_specta::collect_commands![
            greet,
            commands::get_merge_input,
            commands::save_result,
            commands::abort_merge,
            commands::compute_three_way_merge_command,
            commands::compute_word_diff_command,
        ])
}

/// Regenerates `src/bindings.ts` from the current commands. Called from
/// `run()` in debug builds (so bindings stay fresh during development) and
/// from the `export_bindings_to_disk` test (so `cargo test` regenerates them
/// deterministically without launching the full app).
fn export_bindings() {
    specta_builder()
        .export(
            specta_typescript::Typescript::default(),
            "../src/bindings.ts",
        )
        .expect("failed to export typescript bindings");
}

/// Builds and runs the app. `loaded` is the merge input `main.rs` already
/// read and validated before any window exists (fatal input errors exit 2
/// there, never here).
///
/// Exit-code safety: the only ways to exit 0 ("resolved") are `save_result`'s
/// explicit `app.exit(0)`. Every other way out — closing the window, ⌘W,
/// ⌘Q / app-menu Quit — exits 1 ("aborted"), so git never treats a file that
/// may still hold conflict markers as resolved. See `exit::exit_request_override`
/// and `exit::exit_code_on_loop_exit`.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run(args: cli::Args, loaded: commands::LoadedInput) {
    let builder = specta_builder();

    #[cfg(debug_assertions)]
    export_bindings();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(args)
        .manage(loaded)
        .invoke_handler(builder.invoke_handler())
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // The exit code of our own `app.exit(n)` (Save / Abort), once requested.
    let mut explicit_exit_code: Option<i32> = None;
    app.run(move |handle, event| match event {
        tauri::RunEvent::ExitRequested { code, api, .. } => {
            match exit::exit_request_override(code) {
                // Our own app.exit(n): remember it, let it proceed.
                None => explicit_exit_code = code,
                // Last window closed by the user: Tauri would exit 0 here.
                // Re-route through app.exit(Aborted) (which comes back as an
                // explicit request above) so normal cleanup still runs.
                Some(abort_code) => {
                    api.prevent_exit();
                    handle.exit(abort_code);
                }
            }
        }
        tauri::RunEvent::Exit => {
            // Plugins (e.g. the store's save-on-exit) have already handled
            // `Exit` by the time this callback runs.
            if let Some(code) = exit::exit_code_on_loop_exit(explicit_exit_code) {
                std::process::exit(code);
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scaffold_sanity() {
        assert_eq!(2 + 2, 4);
    }

    /// Regenerates `src/bindings.ts` as part of `cargo test`, so the
    /// generated TypeScript bindings never drift from the Rust command
    /// signatures without a test run noticing.
    #[test]
    fn export_bindings_to_disk() {
        export_bindings();
    }
}
