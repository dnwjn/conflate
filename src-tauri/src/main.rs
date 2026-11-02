// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use conflate_lib::{cli, commands, exit};

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    match cli::parse_args(&argv) {
        // Read and validate every input (existence, readability, UTF-8 —
        // i.e. not a binary file) BEFORE the Tauri app or any window exists,
        // so a fatal input error exits 2 without a window ever flashing up.
        Ok(args) => {
            match commands::load_merge_input(&args.base, &args.local, &args.remote, &args.merged) {
                Ok(loaded) => conflate_lib::run(args, loaded),
                Err(msg) => exit::fatal(&format!("conflate: {msg}")),
            }
        }
        // --help / --version are successful requests, not errors: stdout, exit 0.
        Err(cli::CliError::Help(text) | cli::CliError::Version(text)) => println!("{text}"),
        Err(err) => exit::fatal(&err.to_string()),
    }
}
