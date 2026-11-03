// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use conflate_lib::{cli, commands, exit, git_labels};

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    match cli::parse_args(&argv) {
        // Read and validate every input (existence, readability, UTF-8 —
        // i.e. not a binary file) BEFORE the Tauri app or any window exists,
        // so a fatal input error exits 2 without a window ever flashing up.
        Ok(args) => {
            match commands::load_merge_input(&args.base, &args.local, &args.remote, &args.merged) {
                Ok(mut loaded) => {
                    // Best-effort: branch labels are a nice-to-have, never a
                    // reason to fail the merge. `git mergetool` runs us with
                    // the repo (worktree) root as cwd.
                    let cwd =
                        std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
                    let (local_branch, remote_branch) = git_labels::detect_branch_labels(&cwd);
                    loaded.payload.local_branch = local_branch;
                    loaded.payload.remote_branch = remote_branch;
                    conflate_lib::run(args, loaded)
                }
                Err(msg) => exit::fatal(&format!("conflate: {msg}")),
            }
        }
        // --help / --version are successful requests, not errors: stdout, exit 0.
        Err(cli::CliError::Help(text) | cli::CliError::Version(text)) => println!("{text}"),
        Err(err) => exit::fatal(&err.to_string()),
    }
}
