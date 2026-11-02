use std::process::{Command, Output};

fn run_conflate(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_conflate"))
        .args(args)
        .output()
        .expect("failed to run conflate binary")
}

#[test]
fn help_prints_to_stdout_and_exits_zero() {
    let out = run_conflate(&["--help"]);
    assert_eq!(
        out.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(String::from_utf8_lossy(&out.stdout).contains("Usage:"));
    assert!(out.stderr.is_empty());
}

#[test]
fn version_prints_to_stdout_and_exits_zero() {
    let out = run_conflate(&["--version"]);
    assert_eq!(
        out.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(String::from_utf8_lossy(&out.stdout).starts_with("conflate "));
    assert!(out.stderr.is_empty());
}

#[test]
fn bad_arguments_print_to_stderr_and_exit_two() {
    let out = run_conflate(&["only_one.txt"]);
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("Usage:"));
    assert!(out.stdout.is_empty());
}

/// Binary (non-UTF-8) inputs are rejected in `main.rs` before the Tauri app
/// is built: exit 2 with a message on stderr, and no window ever opens (if
/// it did, this test would block on the GUI instead of returning).
#[test]
fn binary_input_exits_two_before_any_window_opens() {
    let dir = tempfile::tempdir().unwrap();
    let path = |name: &str| dir.path().join(name).to_str().unwrap().to_string();
    let binary: &[u8] = &[0x89, b'P', b'N', b'G', 0, 0xff, 0xfe];
    for role in ["local", "remote", "base"] {
        for name in ["base", "local", "remote"] {
            let content: &[u8] = if name == role { binary } else { b"text\n" };
            std::fs::write(path(name), content).unwrap();
        }
        let out = run_conflate(&[
            &path("base"),
            &path("local"),
            &path("remote"),
            &path("merged"),
        ]);
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert_eq!(out.status.code(), Some(2), "{role}: stderr: {stderr}");
        assert!(stderr.contains(&format!("{role} file")), "{role}: {stderr}");
        assert!(stderr.contains("not valid UTF-8"), "{role}: {stderr}");
        assert!(out.stdout.is_empty());
        assert!(
            !dir.path().join("merged").exists(),
            "nothing may be written"
        );
    }
}
