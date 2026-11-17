//! Paths handed to MINT from outside the window: double-clicking a document
//! (file association), `mint notes.md` on the command line, or a second launch
//! that forwards its arguments to the running app. They wait here until a
//! window takes them, so none is lost while the page is still loading.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

/// A path to open, and whether it is a folder or a document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedPath {
    pub path: PathBuf,
    pub kind: crate::folder::EntryKind,
}

impl OpenedPath {
    /// `None` for a path that does not exist.
    pub fn of(path: PathBuf) -> Option<Self> {
        let metadata = std::fs::metadata(&path)
            .inspect_err(|e| eprintln!("MINT: cannot open {}: {e}", path.display()))
            .ok()?;
        let kind = if metadata.is_dir() {
            crate::folder::EntryKind::Directory
        } else {
            crate::folder::EntryKind::File
        };
        Some(Self { path, kind })
    }
}

/// The paths named by command-line arguments (without the program itself),
/// made absolute against `cwd`. Options (`-x`, `--flag`, macOS's `-psn_…`)
/// and `file:` URLs that are not local are skipped.
pub fn paths_from_args<I, S>(args: I, cwd: &Path) -> Vec<PathBuf>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .filter_map(|arg| {
            let arg = arg.as_ref();
            if arg.is_empty() || arg.starts_with('-') {
                return None;
            }
            let path = match arg.strip_prefix("file://") {
                Some(rest) => PathBuf::from(percent_decode(rest)),
                None => PathBuf::from(arg),
            };
            Some(if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            })
        })
        .collect()
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((high * 16 + low) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Paths waiting for a window to open them.
#[derive(Default)]
pub struct Pending(Mutex<Vec<OpenedPath>>);

impl Pending {
    pub fn push(&self, paths: impl IntoIterator<Item = OpenedPath>) {
        let mut pending = self.0.lock().unwrap_or_else(|e| e.into_inner());
        for path in paths {
            if !pending.contains(&path) {
                pending.push(path);
            }
        }
    }

    /// Every waiting path, oldest first; afterwards none is waiting.
    pub fn take(&self) -> Vec<OpenedPath> {
        std::mem::take(&mut *self.0.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::folder::EntryKind;

    #[test]
    fn arguments_become_absolute_paths_and_options_are_skipped() {
        let cwd = Path::new("/home/me/notes");
        let paths = paths_from_args(
            [
                "a.md",
                "-psn_0_12345",
                "--verbose",
                "/tmp/b.markdown",
                "sub/c.md",
                "",
            ],
            cwd,
        );

        assert_eq!(
            paths,
            vec![
                PathBuf::from("/home/me/notes/a.md"),
                PathBuf::from("/tmp/b.markdown"),
                PathBuf::from("/home/me/notes/sub/c.md"),
            ]
        );
    }

    #[test]
    fn local_file_urls_are_decoded() {
        let paths = paths_from_args(["file:///tmp/my%20notes.md"], Path::new("/"));

        assert_eq!(paths, vec![PathBuf::from("/tmp/my notes.md")]);
    }

    #[test]
    fn existing_paths_are_classified_and_missing_ones_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let doc = dir.path().join("a.md");
        std::fs::write(&doc, "# A").unwrap();

        assert_eq!(
            OpenedPath::of(doc.clone()).map(|p| p.kind),
            Some(EntryKind::File)
        );
        assert_eq!(
            OpenedPath::of(dir.path().to_path_buf()).map(|p| p.kind),
            Some(EntryKind::Directory)
        );
        assert_eq!(OpenedPath::of(dir.path().join("missing.md")), None);
    }

    #[test]
    fn waiting_paths_are_taken_once_without_duplicates() {
        let dir = tempfile::tempdir().unwrap();
        let doc = OpenedPath::of(dir.path().to_path_buf()).unwrap();
        let pending = Pending::default();

        pending.push([doc.clone(), doc.clone()]);

        assert_eq!(pending.take(), vec![doc]);
        assert!(pending.take().is_empty());
    }
}
