//! Word-level diff of a single changed line, for intra-line highlighting.

use similar::{ChangeTag, TextDiff};

use super::types::{WordDiffKind, WordDiffOp};

/// Diffs `old` against `new` at word granularity using
/// `similar::TextDiff::from_words`.
///
/// Tokenization is `similar`'s word split: each run of non-whitespace is one
/// token, and each run of whitespace is a separate token. Whitespace is
/// therefore *not* ignored: a change in the amount of whitespace between two
/// words shows up as a `Delete` of the old whitespace run followed by an
/// `Insert` of the new one, not as `Equal`.
///
/// Adjacent segments of the same kind are coalesced into one op, so the
/// result alternates between kinds and concatenating the `Equal` and
/// `Delete` texts reproduces `old`, while concatenating `Equal` and `Insert`
/// texts reproduces `new`.
pub fn compute_word_diff(old: &str, new: &str) -> Vec<WordDiffOp> {
    let diff = TextDiff::from_words(old, new);
    let mut ops: Vec<WordDiffOp> = Vec::new();
    for change in diff.iter_all_changes() {
        let kind = match change.tag() {
            ChangeTag::Equal => WordDiffKind::Equal,
            ChangeTag::Insert => WordDiffKind::Insert,
            ChangeTag::Delete => WordDiffKind::Delete,
        };
        let text = change.value();
        match ops.last_mut() {
            Some(last) if last.kind == kind => last.text.push_str(text),
            _ => ops.push(WordDiffOp {
                kind,
                text: text.to_string(),
            }),
        }
    }
    ops
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn word_substitution_produces_delete_and_insert_ops() {
        let ops = compute_word_diff("let foo = 1;", "let bar = 1;");
        assert!(
            ops.iter()
                .any(|o| o.kind == WordDiffKind::Delete && o.text.contains("foo"))
        );
        assert!(
            ops.iter()
                .any(|o| o.kind == WordDiffKind::Insert && o.text.contains("bar"))
        );
    }

    #[test]
    fn pure_insertion_at_end() {
        let ops = compute_word_diff("let x = 1;", "let x = 1; // comment");
        assert!(ops.iter().any(|o| o.kind == WordDiffKind::Insert));
        assert!(ops.iter().any(|o| o.kind == WordDiffKind::Equal));
    }

    fn op(kind: WordDiffKind, text: &str) -> WordDiffOp {
        WordDiffOp {
            kind,
            text: text.to_string(),
        }
    }

    /// Pins the observed `similar` word tokenization: whitespace runs are
    /// their own tokens, so a whitespace-only change is a Delete/Insert pair
    /// of whitespace segments rather than an Equal.
    #[test]
    fn whitespace_only_change_is_delete_and_insert_of_whitespace_run() {
        let ops = compute_word_diff("let x = 1;", "let  x = 1;");
        assert_eq!(
            ops,
            vec![
                op(WordDiffKind::Equal, "let"),
                op(WordDiffKind::Delete, " "),
                op(WordDiffKind::Insert, "  "),
                op(WordDiffKind::Equal, "x = 1;"),
            ]
        );
    }

    #[test]
    fn identical_inputs_produce_single_equal_op() {
        let ops = compute_word_diff("same line", "same line");
        assert_eq!(ops, vec![op(WordDiffKind::Equal, "same line")]);
    }

    #[test]
    fn ops_reconstruct_both_inputs() {
        let old = "fn main() { println!(\"a\"); }";
        let new = "fn run(x: u8) { println!(\"b\", x); }";
        let ops = compute_word_diff(old, new);
        let from_old: String = ops
            .iter()
            .filter(|o| o.kind != WordDiffKind::Insert)
            .map(|o| o.text.as_str())
            .collect();
        let from_new: String = ops
            .iter()
            .filter(|o| o.kind != WordDiffKind::Delete)
            .map(|o| o.text.as_str())
            .collect();
        assert_eq!(from_old, old);
        assert_eq!(from_new, new);
    }
}
