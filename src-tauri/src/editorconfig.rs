use std::fs;
use std::path::Path;

use serde::Serialize;
use specta::Type;

/// Effective indentation settings for a file, resolved from its
/// `.editorconfig` ancestry (see [`resolve_indent_config`]). `source` tells
/// the frontend whether it should still try content-based detection as a
/// fallback.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IndentConfig {
    /// `"tab"` or `"space"`, when an `.editorconfig` section matched.
    pub indent_style: Option<String>,
    pub indent_size: Option<u32>,
    /// `"editorconfig"` when any property was found, `"none"` otherwise.
    pub source: String,
}

#[derive(Default, Clone)]
struct IndentProps {
    indent_style: Option<String>,
    indent_size: Option<u32>,
    tab_width: Option<u32>,
}

impl IndentProps {
    fn merge_from(&mut self, other: &IndentProps) {
        if other.indent_style.is_some() {
            self.indent_style = other.indent_style.clone();
        }
        if other.indent_size.is_some() {
            self.indent_size = other.indent_size;
        }
        if other.tab_width.is_some() {
            self.tab_width = other.tab_width;
        }
    }
}

/// Resolves the effective `indent_style`/`indent_size` for `file_path` by
/// walking its `.editorconfig` ancestry: starting at the file's own
/// directory and going up, each `.editorconfig` found is parsed and its
/// matching properties recorded, stopping after a file declares `root =
/// true`. Closer directories take precedence over farther ones, matching
/// real EditorConfig semantics.
///
/// Only a limited glob subset is supported in section headers: `[*]`
/// (applies to every file) and `[*.ext]` / `[*.{ext1,ext2}]` (extension
/// lists). Other glob forms (`**`, numeric ranges, character classes,
/// path-segment globs) are not recognized and such sections are simply
/// never matched.
pub fn resolve_indent_config(file_path: &Path) -> IndentConfig {
    let Some(file_name) = file_path.file_name().and_then(|n| n.to_str()) else {
        return IndentConfig {
            indent_style: None,
            indent_size: None,
            source: "none".into(),
        };
    };

    // Closest-first; merged farthest-first below so closer directories win.
    let mut layers: Vec<IndentProps> = Vec::new();
    let mut dir = file_path.parent().map(Path::to_path_buf);
    while let Some(d) = dir {
        let candidate = d.join(".editorconfig");
        if let Ok(contents) = fs::read_to_string(&candidate) {
            let (props, is_root) = parse_editorconfig(&contents, file_name);
            layers.push(props);
            if is_root {
                break;
            }
        }
        dir = d.parent().map(Path::to_path_buf);
    }

    let mut merged = IndentProps::default();
    for props in layers.iter().rev() {
        merged.merge_from(props);
    }

    let effective_size = merged.indent_size.or(merged.tab_width);
    if merged.indent_style.is_none() && effective_size.is_none() {
        IndentConfig {
            indent_style: None,
            indent_size: None,
            source: "none".into(),
        }
    } else {
        IndentConfig {
            indent_style: merged.indent_style,
            indent_size: effective_size,
            source: "editorconfig".into(),
        }
    }
}

/// Parses one `.editorconfig` file's contents, returning the properties that
/// apply to `file_name` (last matching section wins per key, matching the
/// spec) and whether this file declared `root = true`.
fn parse_editorconfig(contents: &str, file_name: &str) -> (IndentProps, bool) {
    let mut props = IndentProps::default();
    let mut is_root = false;
    let mut current_matches = false;
    let mut in_preamble = true;

    for raw_line in contents.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            in_preamble = false;
            let glob = &line[1..line.len() - 1];
            current_matches = glob_matches(glob, file_name);
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        let value = value.trim();

        if in_preamble && key == "root" {
            is_root = value.eq_ignore_ascii_case("true");
            continue;
        }
        if !current_matches {
            continue;
        }

        match key.as_str() {
            "indent_style" => {
                let v = value.to_ascii_lowercase();
                if v == "tab" || v == "space" {
                    props.indent_style = Some(v);
                }
            }
            "indent_size" => {
                if let Ok(n) = value.parse::<u32>() {
                    props.indent_size = Some(n);
                }
            }
            "tab_width" => {
                if let Ok(n) = value.parse::<u32>() {
                    props.tab_width = Some(n);
                }
            }
            _ => {}
        }
    }

    (props, is_root)
}

/// Matches a (very) limited subset of EditorConfig section globs against a
/// bare file name: `*`, `*.ext`, and `*.{ext1,ext2,...}`.
fn glob_matches(glob: &str, file_name: &str) -> bool {
    let glob = glob.trim();
    if glob == "*" {
        return true;
    }
    let Some(rest) = glob.strip_prefix("*.") else {
        return false;
    };
    let lower_name = file_name.to_ascii_lowercase();
    if let Some(inner) = rest.strip_prefix('{').and_then(|s| s.strip_suffix('}')) {
        return inner.split(',').map(str::trim).any(|ext| {
            !ext.is_empty() && lower_name.ends_with(&format!(".{}", ext.to_ascii_lowercase()))
        });
    }
    !rest.is_empty() && lower_name.ends_with(&format!(".{}", rest.to_ascii_lowercase()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_editorconfig_yields_none_source() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("foo.rs");
        std::fs::write(&file, "fn main() {}\n").unwrap();
        let config = resolve_indent_config(&file);
        assert_eq!(config.source, "none");
        assert!(config.indent_style.is_none());
        assert!(config.indent_size.is_none());
    }

    #[test]
    fn matches_universal_section() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".editorconfig"),
            "root = true\n[*]\nindent_style = tab\nindent_size = 4\n",
        )
        .unwrap();
        let file = dir.path().join("foo.rs");
        std::fs::write(&file, "fn main() {}\n").unwrap();
        let config = resolve_indent_config(&file);
        assert_eq!(config.source, "editorconfig");
        assert_eq!(config.indent_style.as_deref(), Some("tab"));
        assert_eq!(config.indent_size, Some(4));
    }

    #[test]
    fn extension_specific_section_only_matches_that_extension() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".editorconfig"),
            "root = true\n[*.rs]\nindent_style = space\nindent_size = 4\n[*.md]\nindent_style = tab\n",
        )
        .unwrap();
        let rs = dir.path().join("foo.rs");
        std::fs::write(&rs, "").unwrap();
        let md = dir.path().join("foo.md");
        std::fs::write(&md, "").unwrap();
        let txt = dir.path().join("foo.txt");
        std::fs::write(&txt, "").unwrap();

        assert_eq!(resolve_indent_config(&rs).indent_style.as_deref(), Some("space"));
        assert_eq!(resolve_indent_config(&md).indent_style.as_deref(), Some("tab"));
        assert_eq!(resolve_indent_config(&txt).source, "none");
    }

    #[test]
    fn brace_extension_list_matches_any_listed_extension() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".editorconfig"),
            "root = true\n[*.{ts,tsx}]\nindent_style = space\nindent_size = 2\n",
        )
        .unwrap();
        let tsx = dir.path().join("foo.tsx");
        std::fs::write(&tsx, "").unwrap();
        let config = resolve_indent_config(&tsx);
        assert_eq!(config.indent_style.as_deref(), Some("space"));
        assert_eq!(config.indent_size, Some(2));
    }

    #[test]
    fn closer_directory_overrides_farther_one() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".editorconfig"),
            "root = true\n[*]\nindent_style = tab\nindent_size = 8\n",
        )
        .unwrap();
        let sub = dir.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        std::fs::write(sub.join(".editorconfig"), "[*]\nindent_size = 2\n").unwrap();
        let file = sub.join("foo.rs");
        std::fs::write(&file, "").unwrap();

        let config = resolve_indent_config(&file);
        // indent_style only set farther out -> still applies.
        assert_eq!(config.indent_style.as_deref(), Some("tab"));
        // indent_size overridden by the closer directory.
        assert_eq!(config.indent_size, Some(2));
    }

    #[test]
    fn root_true_stops_the_upward_walk() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".editorconfig"),
            "root = true\n[*]\nindent_style = tab\n",
        )
        .unwrap();
        let sub = dir.path().join("sub");
        std::fs::create_dir(&sub).unwrap();
        // No root here, so without a stop it would keep climbing to the
        // outer one anyway in this test — the real assertion is that a
        // closer `root = true` stops the walk before an even farther layer
        // (simulated by nesting one level deeper with its own root).
        std::fs::write(sub.join(".editorconfig"), "root = true\n[*]\nindent_style = space\n").unwrap();
        let file = sub.join("foo.rs");
        std::fs::write(&file, "").unwrap();

        let config = resolve_indent_config(&file);
        assert_eq!(config.indent_style.as_deref(), Some("space"));
    }

    #[test]
    fn tab_width_is_used_when_indent_size_absent() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(".editorconfig"),
            "root = true\n[*]\nindent_style = tab\ntab_width = 3\n",
        )
        .unwrap();
        let file = dir.path().join("foo.rs");
        std::fs::write(&file, "").unwrap();
        assert_eq!(resolve_indent_config(&file).indent_size, Some(3));
    }
}
