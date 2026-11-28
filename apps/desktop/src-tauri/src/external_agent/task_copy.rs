//! Stage approved writing materials and import changes to Markdown task copies.
use super::{WritingRequest, FAILED, MAX_OUTPUT, SANDBOX_UNAVAILABLE};
use crate::document_edit::{valid_folder_document, valid_folder_path};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const PROFILE: &str = "mint-task-copy";
const DRAFT: &str = "draft.md";
const MATERIALS: &str = "materials";
const DOCUMENTS: &str = "documents";
const MOVES: &str = "moves.json";
const MAX_DOCUMENTS: usize = 256;
const MAX_ENTRIES: usize = 2048;
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Mode {
    Edit,
    Draft,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Document {
    path: String,
    text: String,
}

#[derive(Serialize)]
pub(super) struct Change {
    path: String,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    from: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Move {
    from: String,
    to: String,
}

enum Baseline {
    Manuscript(String),
    Folder(BTreeMap<String, String>),
}

type Changes = (Option<String>, Option<Vec<Change>>, bool);

pub(super) const SUPPORTED: bool = cfg!(any(target_os = "linux", target_os = "macos"));

/// Codex applies this profile to its tools. The trusted CLI itself keeps its
/// existing login and talks to the provider. https://learn.chatgpt.com/docs/permissions
fn permissions(command: &mut Command, executable: &Path) -> Result<(), String> {
    let binary = executable.to_str().ok_or(SANDBOX_UNAVAILABLE)?;
    let binary = serde_json::to_string(binary).map_err(|_| SANDBOX_UNAVAILABLE)?;
    // The Codex CLI invokes its own binary inside the sandbox for filesystem tools.
    let filesystem = format!(
        r#"permissions.mint-task-copy.filesystem={{":root"="deny",":minimal"="read",":tmpdir"="deny",":slash_tmp"="deny",":workspace_roots"={{"."="write"}},{binary}="read"}}"#
    );
    command
        .arg("-c")
        .arg(filesystem)
        .args(["-c", "permissions.mint-task-copy.network.enabled=false"]);
    Ok(())
}

pub(super) fn configure(command: &mut Command, executable: &Path) -> Result<(), String> {
    permissions(command, executable)?;
    command.args([
        "--strict-config",
        "-c",
        r#"default_permissions="mint-task-copy""#,
        "-c",
        r#"web_search="disabled""#,
        "-c",
        r#"shell_environment_policy.inherit="none""#,
        "-c",
        "allow_login_shell=false",
        "--ignore-user-config",
        "--ignore-rules",
    ]);
    Ok(())
}

pub(super) fn verify(
    mut command: Command,
    workspace: &Path,
    private: &Path,
    stopped: &AtomicBool,
) -> Result<(), String> {
    let unavailable = || SANDBOX_UNAVAILABLE.to_owned();
    let outside = private.join("check-outside");
    let inside = workspace.join("check-inside");
    let codex_home = private.join("check-config");
    fs::create_dir(&codex_home).map_err(|_| unavailable())?;
    fs::write(&outside, b"private").map_err(|_| unavailable())?;
    fs::write(&inside, b"public").map_err(|_| unavailable())?;
    command.arg("sandbox");
    let executable = Path::new(command.get_program()).to_owned();
    permissions(&mut command, &executable)?;
    command
        .args([
            "--permission-profile",
            PROFILE,
            "--include-managed-config",
            "--cd",
        ])
        .arg(workspace)
        .args([
            "--",
            "/bin/sh",
            "-c",
            r#"
test "$(/bin/cat check-inside)" = public &&
printf verified > check-inside &&
! /bin/cat "$1" &&
! (printf blocked > "$1")
"#,
            "mint-task-copy-check",
        ])
        .arg(&outside)
        .env("CODEX_HOME", codex_home)
        .current_dir(workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if stopped.load(Ordering::Relaxed) {
        return Err("stopped".to_owned());
    }
    let mut child = super::AgentProcess::spawn(&mut command).map_err(|_| unavailable())?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success()
                    || fs::read(&inside).ok().as_deref() != Some(b"verified")
                    || fs::read(&outside).ok().as_deref() != Some(b"private")
                {
                    return Err(unavailable());
                }
                fs::remove_file(&inside).map_err(|_| unavailable())?;
                return Ok(());
            }
            Ok(None) if !stopped.load(Ordering::Relaxed) && started.elapsed() < PROBE_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(40));
            }
            _ => {
                return Err(if stopped.load(Ordering::Relaxed) {
                    "stopped".to_owned()
                } else {
                    unavailable()
                });
            }
        }
    }
}

pub(super) struct TaskCopy<'a> {
    workspace: &'a Path,
    baseline: Baseline,
    materials: Vec<String>,
}

impl<'a> TaskCopy<'a> {
    pub(super) fn stage(
        workspace: &'a Path,
        request: &WritingRequest,
    ) -> Result<(Self, Vec<u8>), String> {
        let failed = || FAILED.to_owned();
        let mut payload = serde_json::to_value(request).map_err(|_| failed())?;
        // The selection is the only writable target for selection tasks. An explicitly
        // included full manuscript becomes a reference file in that case.
        let selection = payload
            .as_object_mut()
            .ok_or_else(failed)?
            .remove("selectedText");
        let baseline = if let Some(documents) = &request.folder_documents {
            let (baseline, files) = stage_folder(workspace, documents)?;
            payload["folderDocuments"] = json!(files);
            Baseline::Folder(baseline)
        } else {
            let current_draft = payload.pointer_mut("/taskContext/currentDraft");
            let baseline = match (request.task_copy, selection, current_draft) {
                (Some(Mode::Draft), _, _) => String::new(),
                (Some(Mode::Edit), Some(Value::String(text)), _) => text,
                (Some(Mode::Edit), _, Some(draft)) => {
                    let text = take_text(draft)?;
                    draft["file"] = json!(DRAFT);
                    text
                }
                _ => return Err(failed()),
            };
            fs::write(workspace.join(DRAFT), &baseline).map_err(|_| failed())?;
            Baseline::Manuscript(baseline)
        };
        let instructions = match &baseline {
            Baseline::Manuscript(_) => "Work on draft.md in the current directory. Write the resulting Markdown to draft.md. Use the listed material files as references. If asking MINT for more material, leave draft.md unchanged. Do not write the revised Markdown in your reply.",
            Baseline::Folder(_) => r#"Use only the listed document files and reference materials. Edit Markdown files under documents/ in place, and create new Markdown files under documents/ as needed. For each move or rename, move the file and record the operation in moves.json in the current directory, as an array such as [{"from":"old.md","to":"chapter/new.md"}]. Paths in moves.json are relative to documents/. Record moves even when you also edit the moved file. Use folder-relative filenames and update affected links in the included documents. Do not delete documents, edit reference material, or modify any files outside the task copy. If asking MINT for additional material, leave all files unchanged. Briefly describe the result in your reply."#,
        };
        if request.folder_write_targets.is_some() {
            payload["writeTargetInstructions"] = json!("Only the relative paths listed in folderWriteTargets are authorized for writing to the working folder. Edit only these paths under documents/. Both paths of a move must be listed.");
        }
        let mut copy = Self {
            workspace,
            baseline,
            materials: Vec::new(),
        };
        if let Some(context) = payload
            .get_mut("taskContext")
            .and_then(Value::as_object_mut)
        {
            if let Some(reference) = context
                .get_mut("currentDraft")
                .filter(|item| item.get("text").is_some())
            {
                copy.stage_material(reference)?;
            }
            if let Some(materials) = context.get_mut("materials").and_then(Value::as_array_mut) {
                for material in materials {
                    copy.stage_material(material)?;
                }
            }
            if let Some(decisions) = context
                .get_mut("materialDecisions")
                .and_then(Value::as_array_mut)
            {
                for decision in decisions {
                    if let Some(approved) = decision.get_mut("material") {
                        copy.stage_material(approved)?;
                    }
                }
            }
        }
        let task = payload["instruction"].as_str().ok_or_else(failed)?;
        payload["instruction"] = json!(format!("{task}\n\n{instructions}"));
        // The CLI sees only the relative paths and metadata. Material text stays in the copy.
        payload
            .as_object_mut()
            .ok_or_else(failed)?
            .remove("taskCopy");
        let input = serde_json::to_vec(&payload).map_err(|_| failed())?;
        Ok((copy, input))
    }

    fn stage_material(&mut self, material: &mut Value) -> Result<(), String> {
        let failed = || FAILED.to_owned();
        let text = take_text(material)?;
        let directory = self.workspace.join(MATERIALS);
        if self.materials.is_empty() {
            fs::create_dir(&directory).map_err(|_| failed())?;
        }
        let file = format!("{MATERIALS}/{}.txt", self.materials.len() + 1);
        fs::write(self.workspace.join(&file), &text).map_err(|_| failed())?;
        self.materials.push(text);
        material["file"] = json!(file);
        Ok(())
    }

    pub(super) fn result(&self) -> Result<Changes, String> {
        let failed = || FAILED.to_owned();
        let (manuscript, files, target, ignored_files) = match &self.baseline {
            Baseline::Manuscript(baseline) => {
                // A missing, linked or non-regular target is a failed edit, never a deletion.
                let text = read_regular(&self.workspace.join(DRAFT)).map_err(|_| failed())?;
                ((text != *baseline).then_some(text), None, DRAFT, false)
            }
            Baseline::Folder(baseline) => {
                let (changes, ignored) =
                    folder_changes(self.workspace, baseline).map_err(|_| failed())?;
                (None, Some(changes), DOCUMENTS, ignored)
            }
        };
        let mut ignored = ignored_files;
        for entry in fs::read_dir(self.workspace).map_err(|_| failed())? {
            let name = entry.map_err(|_| failed())?.file_name();
            ignored |= name != target
                && (name != MATERIALS || self.materials.is_empty())
                && (target != DOCUMENTS || name != MOVES);
        }
        if !self.materials.is_empty() {
            let references = self.workspace.join(MATERIALS);
            ignored |= !fs::symlink_metadata(&references).is_ok_and(|info| info.is_dir())
                || fs::read_dir(&references)
                    .map_or(true, |entries| entries.count() != self.materials.len())
                || self.materials.iter().enumerate().any(|(index, original)| {
                    let file = references.join(format!("{}.txt", index + 1));
                    read_regular(&file).ok().as_ref() != Some(original)
                });
        }
        Ok((manuscript, files, ignored))
    }
}

fn stage_folder(
    workspace: &Path,
    documents: &[Document],
) -> Result<(BTreeMap<String, String>, Vec<String>), String> {
    let failed = || FAILED.to_owned();
    if documents.len() > MAX_DOCUMENTS {
        return Err("materialCapacity".to_owned());
    }
    let root = workspace.join(DOCUMENTS);
    fs::create_dir(&root).map_err(|_| failed())?;
    let mut baseline = BTreeMap::new();
    let mut files = Vec::with_capacity(documents.len());
    for Document { path, text } in documents {
        if path.len() > 1024 || !valid_folder_document(path) || baseline.contains_key(path) {
            return Err(failed());
        }
        let file = root.join(path);
        fs::create_dir_all(file.parent().ok_or_else(failed)?).map_err(|_| failed())?;
        crate::document_edit::create(&file, text.as_bytes()).map_err(|_| failed())?;
        baseline.insert(path.clone(), text.clone());
        files.push(format!("{DOCUMENTS}/{path}"));
    }
    Ok((baseline, files))
}

fn folder_changes(
    workspace: &Path,
    baseline: &BTreeMap<String, String>,
) -> io::Result<(Vec<Change>, bool)> {
    let root = workspace.join(DOCUMENTS);
    if !fs::symlink_metadata(&root)?.is_dir() {
        return Err(io::Error::other("invalid folder copy"));
    }
    let mut changed = BTreeMap::new();
    let mut pending = vec![(root, String::new())];
    let mut total_bytes = 0;
    let mut entries = 0;
    let mut ignored = false;
    while let Some((dir, prefix)) = pending.pop() {
        for entry in fs::read_dir(dir)? {
            entries += 1;
            if entries > MAX_ENTRIES {
                return Err(io::Error::other("too many entries in folder copy"));
            }
            let entry = entry?;
            let kind = entry.file_type()?;
            let Ok(name) = entry.file_name().into_string() else {
                ignored = true;
                continue;
            };
            let path = format!("{prefix}{name}");
            if path.len() > 1024 || !valid_folder_path(&path) {
                ignored = true;
            } else if kind.is_dir() {
                pending.push((entry.path(), format!("{path}/")));
            } else if kind.is_file() && valid_folder_document(&path) {
                let Ok(text) = read_regular(&entry.path()) else {
                    ignored = true;
                    continue;
                };
                total_bytes += text.len() as u64;
                if total_bytes > MAX_OUTPUT || changed.len() >= MAX_DOCUMENTS {
                    return Err(io::Error::other("folder copy output too large"));
                }
                changed.insert(path, text);
            } else {
                ignored = true;
            }
        }
    }

    let mut moves = BTreeMap::new();
    let mut moved = std::collections::BTreeSet::new();
    let manifest = workspace.join(MOVES);
    if fs::symlink_metadata(&manifest).is_ok() {
        if let Some(entries) = read_regular(&manifest)
            .ok()
            .and_then(|text| serde_json::from_str::<Vec<Move>>(&text).ok())
            .filter(|entries| entries.len() <= MAX_DOCUMENTS)
        {
            for Move { from, to } in entries {
                if baseline.contains_key(&from)
                    && !baseline.contains_key(&to)
                    && !changed.contains_key(&from)
                    && changed.contains_key(&to)
                    && !moves.contains_key(&to)
                    && moved.insert(from.clone())
                {
                    moves.insert(to, from);
                } else {
                    ignored = true;
                }
            }
        } else {
            ignored = true;
        }
    }
    ignored |= baseline
        .keys()
        .any(|path| !changed.contains_key(path) && !moved.contains(path));
    let changes = changed
        .into_iter()
        .filter(|(path, text)| baseline.get(path) != Some(text))
        .map(|(path, text)| Change {
            from: moves.remove(&path),
            path,
            text,
        })
        .collect();
    Ok((changes, ignored))
}

fn take_text(material: &mut Value) -> Result<String, String> {
    match material
        .as_object_mut()
        .and_then(|item| item.remove("text"))
    {
        Some(Value::String(text)) => Ok(text),
        _ => Err(FAILED.to_owned()),
    }
}

fn read_regular(path: &Path) -> io::Result<String> {
    let mut options = File::options();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    let info = file.metadata()?;
    let regular = info.is_file();
    #[cfg(unix)]
    let regular = {
        use std::os::unix::fs::MetadataExt;
        regular && info.nlink() == 1
    };
    if !regular || info.len() > MAX_OUTPUT {
        return Err(io::Error::other("invalid Agent file"));
    }
    let mut text = String::new();
    file.take(MAX_OUTPUT + 1).read_to_string(&mut text)?;
    if text.len() as u64 > MAX_OUTPUT {
        return Err(io::Error::other("Agent file too large"));
    }
    Ok(text)
}
