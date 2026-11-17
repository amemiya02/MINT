//! Global search: find text in every document of a folder, skipping the files
//! `.gitignore` ignores (see [`crate::walk`]). Matching runs line by line with
//! ripgrep's `grep` crates; results are reported one file at a time so the
//! shell can show them while the search is still running.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use grep_matcher::Matcher;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::sinks::UTF8;
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder};
use serde::{Deserialize, Serialize};

use crate::walk;

/// What to search for.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    pub pattern: String,
    #[serde(default)]
    pub case_sensitive: bool,
    /// Only matches that are whole words (not preceded or followed by a word character).
    #[serde(default)]
    pub whole_word: bool,
    /// `pattern` is a regular expression (Rust `regex` syntax); otherwise it is literal text.
    #[serde(default)]
    pub regexp: bool,
}

/// The matching lines of one document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatches {
    pub path: PathBuf,
    pub lines: Vec<LineMatch>,
}

/// One line with at least one match.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineMatch {
    /// 1-based line number.
    pub line: u64,
    /// The line without its line ending (a leading byte order mark on line 1 is kept).
    pub text: String,
    /// Where the matches are in `text`, as `[start, end)` UTF-16 offsets (what the editor uses).
    pub ranges: Vec<[u32; 2]>,
}

/// How a search ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSummary {
    /// The search stopped after [`MAX_LINES`] matching lines.
    pub truncated: bool,
}

/// A search stops after this many matching lines; refining the query finds the rest.
pub const MAX_LINES: usize = 10_000;

/// A compiled query, ready to run over folders.
pub struct Search {
    matcher: RegexMatcher,
}

impl Search {
    /// Compile `query`. Fails with a readable message when the regular expression is invalid.
    pub fn new(query: &SearchQuery) -> Result<Self, String> {
        let matcher = RegexMatcherBuilder::new()
            .case_insensitive(!query.case_sensitive)
            .word(query.whole_word)
            .fixed_strings(!query.regexp)
            .line_terminator(Some(b'\n'))
            .build(&query.pattern)
            .map_err(|e| e.to_string())?;
        Ok(Self { matcher })
    }

    /// Search every file under `root` (see [`walk::walker`]) with one of
    /// `extensions` (any file when empty), in path order. `on_file` receives
    /// each file that has matches as soon as it is searched. Setting
    /// `cancelled` stops the search early. Unreadable files and files that are
    /// not UTF-8 text are skipped.
    pub fn run(
        &self,
        root: &Path,
        extensions: &[String],
        cancelled: &AtomicBool,
        mut on_file: impl FnMut(FileMatches),
    ) -> SearchSummary {
        let mut searcher = SearcherBuilder::new()
            .line_number(true)
            // Keep a BOM in line 1 so offsets agree with the editor's text.
            .bom_sniffing(false)
            .binary_detection(BinaryDetection::quit(b'\0'))
            .build();
        let mut found = 0;
        for path in walk::list_files(root, extensions) {
            if cancelled.load(Ordering::Relaxed) {
                break;
            }
            let lines = self.search_file(&mut searcher, &path, MAX_LINES - found, cancelled);
            if lines.is_empty() {
                continue;
            }
            found += lines.len();
            on_file(FileMatches { path, lines });
            if found >= MAX_LINES {
                return SearchSummary { truncated: true };
            }
        }
        SearchSummary { truncated: false }
    }

    fn search_file(
        &self,
        searcher: &mut Searcher,
        path: &Path,
        limit: usize,
        cancelled: &AtomicBool,
    ) -> Vec<LineMatch> {
        let mut lines = Vec::new();
        let sink = UTF8(|line, text| {
            let text = text.trim_end_matches(['\n', '\r']);
            let ranges = self.ranges(text);
            if !ranges.is_empty() {
                lines.push(LineMatch {
                    line,
                    text: text.to_string(),
                    ranges,
                });
            }
            Ok(lines.len() < limit && !cancelled.load(Ordering::Relaxed))
        });
        if searcher.search_path(&self.matcher, path, sink).is_err() {
            // Not UTF-8 or unreadable: a document MINT cannot open anyway.
            return Vec::new();
        }
        lines
    }

    /// Non-empty matches in `text`, as UTF-16 offsets.
    fn ranges(&self, text: &str) -> Vec<[u32; 2]> {
        let mut ranges = Vec::new();
        let _ = self.matcher.find_iter(text.as_bytes(), |m| {
            if !m.is_empty() {
                ranges.push([utf16_len(&text[..m.start()]), utf16_len(&text[..m.end()])]);
            }
            true
        });
        ranges
    }
}

fn utf16_len(text: &str) -> u32 {
    text.encode_utf16().count() as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(root: &Path, relative: &str, text: &str) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn query(pattern: &str) -> SearchQuery {
        SearchQuery {
            pattern: pattern.to_string(),
            case_sensitive: false,
            whole_word: false,
            regexp: false,
        }
    }

    /// Run a search over markdown documents; returns `(relative path, line, ranges)` per matching line.
    fn search(root: &Path, query: &SearchQuery) -> Vec<(String, u64, Vec<[u32; 2]>)> {
        let mut out = Vec::new();
        let extensions = vec!["md".to_string()];
        Search::new(query)
            .unwrap()
            .run(root, &extensions, &AtomicBool::new(false), |file| {
                let name = file
                    .path
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                for l in file.lines {
                    out.push((name.clone(), l.line, l.ranges));
                }
            });
        out
    }

    #[test]
    fn finds_text_in_every_document_with_line_numbers_and_ranges() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "b.md", "nothing\nthe Cat and the cat\n");
        write(dir.path(), "a/deep.md", "cat\n");
        write(dir.path(), "photo.png", "cat");

        assert_eq!(
            search(dir.path(), &query("cat")),
            vec![
                ("a/deep.md".to_string(), 1, vec![[0, 3]]),
                ("b.md".to_string(), 2, vec![[4, 7], [16, 19]]),
            ]
        );
    }

    #[test]
    fn skips_files_ignored_by_gitignore_and_hidden_files() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), ".gitignore", "build/\n");
        write(dir.path(), "build/out.md", "needle\n");
        write(dir.path(), ".hidden/x.md", "needle\n");
        write(dir.path(), "kept.md", "needle\n");

        let files: Vec<String> = search(dir.path(), &query("needle"))
            .into_iter()
            .map(|(f, _, _)| f)
            .collect();
        assert_eq!(files, vec!["kept.md"]);
    }

    #[test]
    fn case_sensitive_whole_word_and_regexp() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "a.md", "Cat concat cat\n");

        let case = SearchQuery {
            case_sensitive: true,
            ..query("cat")
        };
        assert_eq!(search(dir.path(), &case)[0].2, vec![[7, 10], [11, 14]]);

        let word = SearchQuery {
            whole_word: true,
            ..query("cat")
        };
        assert_eq!(search(dir.path(), &word)[0].2, vec![[0, 3], [11, 14]]);

        let regexp = SearchQuery {
            regexp: true,
            ..query("c[a-z]{2}c")
        };
        assert_eq!(search(dir.path(), &regexp)[0].2, vec![[4, 8]]);
    }

    #[test]
    fn literal_text_is_not_a_regular_expression() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "a.md", "a.b axb (x)\n");
        assert_eq!(search(dir.path(), &query("a.b"))[0].2, vec![[0, 3]]);
        assert_eq!(search(dir.path(), &query("(x)"))[0].2, vec![[8, 11]]);
    }

    #[test]
    fn an_invalid_regular_expression_is_an_error() {
        let invalid = SearchQuery {
            regexp: true,
            ..query("(")
        };
        assert!(Search::new(&invalid).is_err());
    }

    #[test]
    fn ranges_are_utf16_offsets_and_keep_a_bom_and_drop_line_endings() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "a.md", "\u{feff}😀 中文 x\r\nx\r\n");

        let mut lines = Vec::new();
        Search::new(&query("x"))
            .unwrap()
            .run(dir.path(), &[], &AtomicBool::new(false), |f| {
                lines.extend(f.lines)
            });
        assert_eq!(
            lines,
            vec![
                LineMatch {
                    line: 1,
                    text: "\u{feff}😀 中文 x".to_string(),
                    // BOM (1) + emoji (2) + space + 2 CJK + space = 7
                    ranges: vec![[7, 8]],
                },
                LineMatch {
                    line: 2,
                    text: "x".to_string(),
                    ranges: vec![[0, 1]],
                },
            ]
        );
    }

    #[test]
    fn stops_when_cancelled() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "a.md", "x\n");
        write(dir.path(), "b.md", "x\n");
        let cancelled = AtomicBool::new(false);
        let mut files = 0;
        Search::new(&query("x"))
            .unwrap()
            .run(dir.path(), &[], &cancelled, |_| {
                files += 1;
                cancelled.store(true, Ordering::Relaxed);
            });
        assert_eq!(files, 1);
    }

    #[test]
    fn stops_after_the_line_limit() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "a.md", &"x\n".repeat(MAX_LINES - 1));
        write(dir.path(), "b.md", "x\nx\nx\n");
        write(dir.path(), "c.md", "x\n");
        let mut lines = 0;
        let summary =
            Search::new(&query("x"))
                .unwrap()
                .run(dir.path(), &[], &AtomicBool::new(false), |f| {
                    lines += f.lines.len()
                });
        assert_eq!(lines, MAX_LINES);
        assert!(summary.truncated);
    }
}
