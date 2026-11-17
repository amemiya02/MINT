//! Walking the files of a folder the way a person sees it: entries ignored by
//! `.gitignore` (also outside a git repository), `.ignore` and hidden entries
//! (`.git`, `.DS_Store`) are skipped. Quick open lists documents with it, and
//! global search walks the same files.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::{Match, Walk, WalkBuilder};

/// A recursive walk over `root` that skips ignored and hidden entries. Use it
/// for anything that visits "the files of a folder" so every feature agrees on
/// what belongs to it. Symbolic links are not followed.
pub fn walker(root: &Path) -> Walk {
    WalkBuilder::new(root)
        .hidden(true)
        // A folder need not be a git repository for its .gitignore to apply.
        .require_git(false)
        .follow_links(false)
        .build()
}

/// Decides, path by path, whether a change under a folder concerns git's own
/// files (`.git`) or an entry its `.gitignore` / `.ignore` files exclude, the
/// same files [`walker`] skips. Ignore files are read lazily, only for the
/// directories that changed paths lie in, so nothing walks the folder.
pub struct IgnoredPaths {
    root: PathBuf,
    /// The ignore rules of each directory read so far.
    rules: HashMap<PathBuf, Gitignore>,
}

impl IgnoredPaths {
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
            rules: HashMap::new(),
        }
    }

    /// Whether `path` (under the root) is inside `.git` or ignored. A path
    /// outside the root is never ignored.
    pub fn contains(&mut self, path: &Path) -> bool {
        let Ok(relative) = path.strip_prefix(&self.root) else {
            return false;
        };
        if relative.components().any(|c| c.as_os_str() == ".git") {
            return true;
        }
        if path
            .file_name()
            .is_some_and(|n| n == ".gitignore" || n == ".ignore")
        {
            // The rules of that directory changed: read them again next time.
            if let Some(dir) = path.parent() {
                self.rules.remove(dir);
            }
            return false;
        }
        let is_dir = path.is_dir();
        // The deepest ignore file that has a say wins.
        let mut dir = path.parent();
        while let Some(current) = dir.filter(|d| d.starts_with(&self.root)) {
            match self
                .rules_of(current)
                .matched_path_or_any_parents(path, is_dir)
            {
                Match::Ignore(_) => return true,
                Match::Whitelist(_) => return false,
                Match::None => dir = current.parent(),
            }
        }
        false
    }

    fn rules_of(&mut self, dir: &Path) -> &Gitignore {
        self.rules.entry(dir.to_path_buf()).or_insert_with(|| {
            let mut builder = GitignoreBuilder::new(dir);
            // `.ignore` comes last so it takes precedence, as in `walker`. A
            // missing file is fine; a malformed line is skipped.
            for name in [".gitignore", ".ignore"] {
                let _ = builder.add(dir.join(name));
            }
            builder.build().unwrap_or_else(|e| {
                eprintln!(
                    "MINT: cannot read the ignore files of {}: {e}",
                    dir.display()
                );
                Gitignore::empty()
            })
        })
    }
}

/// Every file under `root` (see [`walker`]) whose extension is one of
/// `extensions` (case-insensitive, without the dot), or every file when
/// `extensions` is empty. Sorted by path. Unreadable entries are skipped, and
/// the reason is logged.
pub fn list_files(root: &Path, extensions: &[String]) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = walker(root)
        .filter_map(readable)
        .filter(|entry| entry.file_type().is_some_and(|t| t.is_file()))
        .map(ignore::DirEntry::into_path)
        .filter(|path| extensions.is_empty() || has_extension(path, extensions))
        .collect();
    files.sort();
    files
}

/// The entry, or `None` (with the reason logged) if it cannot be read.
fn readable(entry: Result<ignore::DirEntry, ignore::Error>) -> Option<ignore::DirEntry> {
    entry
        .inspect_err(|e| eprintln!("MINT: skipping an unreadable entry: {e}"))
        .ok()
}

fn has_extension(path: &Path, extensions: &[String]) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| extensions.iter().any(|x| x.eq_ignore_ascii_case(e)))
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

    fn relative(root: &Path, files: Vec<PathBuf>) -> Vec<String> {
        files
            .iter()
            .map(|p| {
                p.strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect()
    }

    fn markdown() -> Vec<String> {
        vec!["md".to_string(), "markdown".to_string()]
    }

    #[test]
    fn lists_files_recursively_sorted() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "b.md", "");
        write(dir.path(), "a/deep/c.md", "");
        write(dir.path(), "photo.png", "");

        assert_eq!(
            relative(dir.path(), list_files(dir.path(), &[])),
            vec!["a/deep/c.md", "b.md", "photo.png"]
        );
    }

    #[test]
    fn filters_by_extension_ignoring_case() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "a.md", "");
        write(dir.path(), "B.MD", "");
        write(dir.path(), "c.markdown", "");
        write(dir.path(), "photo.png", "");
        write(dir.path(), "md", "");

        assert_eq!(
            relative(dir.path(), list_files(dir.path(), &markdown())),
            vec!["B.MD", "a.md", "c.markdown"]
        );
    }

    #[test]
    fn respects_gitignore_without_a_git_repository() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            ".gitignore",
            "build/\n*.draft.md\n!keep.draft.md\n",
        );
        write(dir.path(), "notes.md", "");
        write(dir.path(), "build/out.md", "");
        write(dir.path(), "wip.draft.md", "");
        write(dir.path(), "keep.draft.md", "");
        write(dir.path(), "sub/.gitignore", "local.md\n");
        write(dir.path(), "sub/local.md", "");
        write(dir.path(), "sub/shared.md", "");

        assert_eq!(
            relative(dir.path(), list_files(dir.path(), &markdown())),
            vec!["keep.draft.md", "notes.md", "sub/shared.md"]
        );
    }

    #[test]
    fn skips_hidden_entries() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), ".git/HEAD.md", "");
        write(dir.path(), ".hidden.md", "");
        write(dir.path(), "visible.md", "");

        assert_eq!(
            relative(dir.path(), list_files(dir.path(), &markdown())),
            vec!["visible.md"]
        );
    }

    #[test]
    fn a_missing_folder_has_no_files() {
        let dir = tempfile::tempdir().unwrap();
        assert!(list_files(&dir.path().join("missing"), &[]).is_empty());
    }
}
