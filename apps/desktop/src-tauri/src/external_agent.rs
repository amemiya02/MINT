//! Run the installed Codex CLI with its own sign-in. The scope MINT authorizes
//! is tied to the executable and the requested Codex policy, not the payload.
use crate::writing_requests::Registration;
use crate::{app_data, app_data_dir, blocking};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::env;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::{Channel, JavaScriptChannelId};
use tauri::{AppHandle, Manager, WebviewWindow};

mod task_copy;

const REGISTRY: &str = "external-agents.json";
const POLICY_REVISION: &str = "codex-exec-1";
static REGISTRY_LOCK: Mutex<()> = Mutex::new(());
const MAX_INPUT: usize = 256 * 1024;
const MAX_OUTPUT: u64 = 8 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(120);

const UNAVAILABLE: &str = "agentUnavailable";
const CHANGED: &str = "agentChanged";
const ACCESS_REQUIRED: &str = "agentAccessRequired";
const SANDBOX_UNAVAILABLE: &str = "agentTaskCopyUnavailable";
const FAILED: &str = "agentFailed";

#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentAccess {
    ReadOnly,
    TaskCopy,
    Configured,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WritingRequest {
    instruction: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    task_copy: Option<task_copy::Mode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    folder_documents: Option<Vec<task_copy::Document>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    selected_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    annotation_batch: Option<Vec<WritingAnnotation>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    task_context: Option<TaskContext>,
    #[serde(skip_serializing_if = "Option::is_none")]
    history: Option<Vec<WritingTurn>>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct WritingAnnotation {
    id: String,
    kind: String,
    excerpt: String,
    note: String,
    editable: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    current_draft: Option<NamedMaterial>,
    #[serde(skip_serializing_if = "Option::is_none")]
    materials: Option<Vec<NamedMaterial>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    folder_search: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    material_decisions: Option<Vec<MaterialDecision>>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct NamedMaterial {
    name: String,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    range: Option<MaterialRange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    format: Option<TextMaterialFormat>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", deny_unknown_fields)]
enum MaterialRange {
    Pdf {
        page: u32,
        pages: u32,
    },
    Image {
        x: u32,
        y: u32,
        width: u32,
        height: u32,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum TextMaterialFormat {
    ExtractedText,
    Caption,
    Summary,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", tag = "outcome", deny_unknown_fields)]
enum MaterialDecision {
    Allowed {
        name: String,
        purpose: String,
        material: NamedMaterial,
    },
    Skipped {
        name: String,
        purpose: String,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct WritingTurn {
    instruction: String,
    reply: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WritingReply {
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    task_copy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ignored_changes: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_changes: Option<Vec<task_copy::Change>>,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum AgentEvent {
    Started,
    Text {
        text: String,
    },
    Done {
        reply: Option<WritingReply>,
        error: Option<String>,
    },
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAgent {
    path: PathBuf,
    revision: String,
    approved: Vec<AgentAccess>,
    verified: Vec<AgentAccess>,
    preferred_access: AgentAccess,
    #[serde(default)]
    supports_task_copy: bool,
}

fn inspect(path: &Path) -> Result<ExternalAgent, String> {
    let unavailable = || UNAVAILABLE.to_owned();
    if !path.is_absolute() {
        return Err(unavailable());
    }
    let path = fs::canonicalize(path).map_err(|_| unavailable())?;
    #[cfg(windows)]
    if !path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
    {
        return Err(unavailable());
    }
    let metadata = fs::metadata(&path).map_err(|_| unavailable())?;
    if !metadata.is_file() {
        return Err(unavailable());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return Err(unavailable());
        }
    }
    let modified = metadata.modified().map_err(|_| unavailable())?;
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        (
            metadata.dev(),
            metadata.ino(),
            metadata.ctime(),
            metadata.ctime_nsec(),
        )
    };
    #[cfg(not(unix))]
    let identity = metadata.created().ok();
    let revision = format!(
        "{:x}",
        Sha256::digest(format!(
            "{POLICY_REVISION}\0{path:?}\0{identity:?}\0{modified:?}\0{}",
            metadata.len()
        ))
    );
    Ok(ExternalAgent {
        path,
        revision,
        approved: Vec::new(),
        verified: Vec::new(),
        preferred_access: AgentAccess::ReadOnly,
        supports_task_copy: task_copy::SUPPORTED,
    })
}

fn registry(app: &AppHandle) -> Result<Vec<ExternalAgent>, String> {
    let dir = app_data_dir(app)?.join("ai");
    app_data::read(&dir, REGISTRY)
        .map_err(|_| FAILED.to_owned())?
        .map_or(Ok(Vec::new()), |text| {
            serde_json::from_str(&text).map_err(|_| FAILED.to_owned())
        })
}

fn update_registry(
    app: &AppHandle,
    update: impl FnOnce(&mut Vec<ExternalAgent>) -> Result<(), String>,
) -> Result<(), String> {
    let _lock = REGISTRY_LOCK.lock().map_err(|_| FAILED.to_owned())?;
    let mut records = registry(app)?;
    update(&mut records)?;
    let json = serde_json::to_string_pretty(&records).map_err(|_| FAILED.to_owned())?;
    app_data::write(&app_data_dir(app)?.join("ai"), REGISTRY, &json).map_err(|_| FAILED.to_owned())
}

fn restore(mut agent: ExternalAgent, records: Vec<ExternalAgent>) -> ExternalAgent {
    if let Some(stored) = records
        .into_iter()
        .find(|stored| stored.path == agent.path && stored.revision == agent.revision)
    {
        agent.approved = stored.approved;
        agent.verified = stored.verified;
        agent.preferred_access = stored.preferred_access;
    }
    agent
}

fn same_revision(agent: &ExternalAgent, revision: &str) -> Result<(), String> {
    if agent.revision != revision {
        return Err(CHANGED.to_owned());
    }
    Ok(())
}

fn cli_paths(app: &AppHandle) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = env::var_os("PATH")
        .map(|value| {
            env::split_paths(&value)
                .filter(|path| path.is_absolute())
                .collect()
        })
        .unwrap_or_default();
    #[cfg(unix)]
    paths.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]);
    if let Ok(home) = app.path().home_dir() {
        paths.extend([home.join(".local/bin"), home.join(".cargo/bin")]);
    }
    paths
}

#[tauri::command]
pub async fn discover_external_agents(app: AppHandle) -> Result<Vec<PathBuf>, String> {
    blocking(move || {
        let name = if cfg!(windows) { "codex.exe" } else { "codex" };
        let mut paths = Vec::new();
        for dir in cli_paths(&app) {
            if let Ok(agent) = inspect(&dir.join(name)) {
                if !paths.contains(&agent.path) {
                    paths.push(agent.path);
                }
            }
        }
        Ok(paths)
    })
    .await
}

#[tauri::command]
pub async fn saved_external_agents(app: AppHandle) -> Result<Vec<ExternalAgent>, String> {
    blocking(move || {
        let saved = registry(&app)?;
        Ok(saved
            .into_iter()
            .map(|stored| match inspect(&stored.path) {
                Ok(current) if current.revision != stored.revision => current,
                _ => ExternalAgent {
                    supports_task_copy: task_copy::SUPPORTED,
                    ..stored
                },
            })
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn inspect_external_agent(
    app: AppHandle,
    path: PathBuf,
) -> Result<ExternalAgent, String> {
    blocking(move || Ok(restore(inspect(&path)?, registry(&app)?))).await
}

#[tauri::command]
pub async fn approve_external_agent(
    app: AppHandle,
    path: PathBuf,
    revision: String,
    access: AgentAccess,
) -> Result<ExternalAgent, String> {
    blocking(move || {
        if access == AgentAccess::TaskCopy && !task_copy::SUPPORTED {
            return Err(SANDBOX_UNAVAILABLE.to_owned());
        }
        let mut current = inspect(&path)?;
        same_revision(&current, &revision)?;
        update_registry(&app, |records| {
            if let Some(index) = records
                .iter()
                .position(|stored| stored.path == current.path)
            {
                current = restore(inspect(&path)?, vec![records.remove(index)]);
                same_revision(&current, &revision)?;
            }
            if !current.approved.contains(&access) {
                current.approved.push(access);
            }
            current.preferred_access = access;
            // Make the last used connection the default, including after a restart.
            records.insert(0, current.clone());
            Ok(())
        })?;
        Ok(current)
    })
    .await
}

#[tauri::command]
pub async fn forget_external_agent(app: AppHandle, path: PathBuf) -> Result<(), String> {
    blocking(move || {
        update_registry(&app, |records| {
            records.retain(|stored| stored.path != path);
            Ok(())
        })
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn send_external_agent(
    app: AppHandle,
    window: WebviewWindow,
    path: PathBuf,
    revision: String,
    access: AgentAccess,
    request: WritingRequest,
    task_id: Option<String>,
    request_id: Option<String>,
    on_event: Option<JavaScriptChannelId>,
) -> Result<Option<WritingReply>, String> {
    crate::model::require_document_window(&window).map_err(|_| "denied".to_owned())?;
    let on_event = on_event.map(|id| id.channel_on::<_, AgentEvent>(window.as_ref().clone()));
    let stopped = Arc::new(AtomicBool::new(false));
    let _registration = if let Some(id) = request_id {
        let event = on_event.as_ref().ok_or("invalidRequest")?;
        let cancel = Arc::clone(&stopped);
        let registration = Registration::start(&window, id, move || {
            cancel.store(true, Ordering::Relaxed);
        })?;
        event.send(AgentEvent::Started).map_err(|_| "stopped")?;
        Some(registration)
    } else {
        None
    };
    let progress = on_event.clone();
    let result = blocking(move || {
        let current = restore(inspect(&path)?, registry(&app)?);
        same_revision(&current, &revision)?;
        if !current.approved.contains(&access) {
            return Err(ACCESS_REQUIRED.to_owned());
        }
        let task_copy = access == AgentAccess::TaskCopy;
        if task_copy && !task_copy::SUPPORTED {
            return Err(SANDBOX_UNAVAILABLE.to_owned());
        }
        if !task_copy && (request.task_copy.is_some() || request.folder_documents.is_some()) {
            return Err(ACCESS_REQUIRED.to_owned());
        }
        if request.folder_documents.is_some()
            && (request.task_copy.is_some()
                || request.selected_text.is_some()
                || request
                    .task_context
                    .as_ref()
                    .is_some_and(|context| context.current_draft.is_some()))
        {
            return Err(FAILED.to_owned());
        }
        let scratch = crate::writing_tasks::agent_scratch(&app, task_id.as_deref(), task_copy)
            .map_err(|_| FAILED.to_owned())?;
        let reply = run_codex(
            &current.path,
            access,
            &request,
            &scratch,
            cli_paths(&app),
            &stopped,
            progress.as_ref(),
        )?;
        // Forgetting or replacing a connection during a request must not restore its access.
        let _ = update_registry(&app, |records| {
            if let Some(index) = records.iter().position(|stored| {
                stored.path == current.path
                    && stored.revision == revision
                    && stored.approved.contains(&access)
            }) {
                let mut stored = records.remove(index);
                if (access != AgentAccess::TaskCopy || reply.task_copy.is_some())
                    && !stored.verified.contains(&access)
                {
                    stored.verified.push(access);
                }
                stored.preferred_access = access;
                records.insert(0, stored);
            }
            Ok(())
        });
        Ok(reply)
    })
    .await;
    if let Some(events) = on_event {
        let (reply, error) = match result {
            Ok(reply) => (Some(reply), None),
            Err(error) => (None, Some(error)),
        };
        events
            .send(AgentEvent::Done { reply, error })
            .map_err(|_| "stopped".to_owned())?;
        Ok(None)
    } else {
        result.map(Some)
    }
}

/// Codex exec: https://learn.chatgpt.com/docs/non-interactive-mode
/// Arguments are fixed; task material and conversation travel through stdin. Configured
/// mode deliberately leaves the CLI's policy in place, including its tools.
fn run_codex(
    path: &Path,
    access: AgentAccess,
    request: &WritingRequest,
    scratch: &crate::writing_tasks::AgentScratch,
    paths: Vec<PathBuf>,
    stopped: &AtomicBool,
    events: Option<&Channel<AgentEvent>>,
) -> Result<WritingReply, String> {
    let failed = || FAILED.to_owned();
    let input = serde_json::to_vec(request).map_err(|_| failed())?;
    if input.len() > MAX_INPUT {
        return Err("materialCapacity".to_owned());
    }
    if request.instruction.trim().is_empty() {
        return Err(failed());
    }
    let file_access = access == AgentAccess::TaskCopy;
    let private = scratch.private_spool(file_access).map_err(|_| failed())?;
    let workspace = fs::canonicalize(scratch.path()).map_err(|_| failed())?;
    let (copy, input) = if file_access {
        let spool = fs::canonicalize(private.path()).map_err(|_| failed())?;
        task_copy::verify(
            codex_command(path, &paths, true),
            &workspace,
            &spool,
            stopped,
        )?;
        if request.task_copy.is_some() || request.folder_documents.is_some() {
            let (copy, input) = task_copy::TaskCopy::stage(&workspace, request)?;
            (Some(copy), input)
        } else {
            (None, input)
        }
    } else {
        (None, input)
    };
    // Independent offsets allow live reads. Keep the spool outside the Agent task copy.
    let stdin = temporary_input(&input, private.path()).map_err(|_| failed())?;
    let output = tempfile::NamedTempFile::new_in(private.path()).map_err(|_| failed())?;
    let stdout = output.reopen().map_err(|_| failed())?;
    let mut reader = BufReader::new(output.reopen().map_err(|_| failed())?);
    let mut command = codex_command(path, &paths, file_access);
    command.args([
        "--ask-for-approval",
        "never",
        "exec",
        "--json",
        "--ephemeral",
        "--skip-git-repo-check",
    ]);
    if file_access {
        task_copy::configure(&mut command, path)?;
    } else if access == AgentAccess::ReadOnly {
        command.args([
            "--sandbox",
            "read-only",
            "--ignore-user-config",
            "--ignore-rules",
        ]);
    }
    if stopped.load(Ordering::Relaxed) {
        return Err("stopped".to_owned());
    }
    let mut child = command
        .arg("-")
        .current_dir(workspace.as_path())
        .stdin(Stdio::from(stdin))
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| failed())?;
    let start = Instant::now();
    let mut output = AgentOutput::default();
    let result = loop {
        if stopped.load(Ordering::Relaxed) {
            break Err("stopped".to_owned());
        }
        if start.elapsed() >= TIMEOUT {
            break Err("timeout".to_owned());
        }
        let status = child.try_wait().map_err(|_| failed());
        if let Err(error) = output.read(&mut reader, events) {
            break Err(error);
        }
        match status {
            Err(error) => break Err(error),
            Ok(Some(status)) => {
                break match output.text {
                    Some(text) if status.success() && output.completed => Ok(text),
                    None if status.success() && output.completed && copy.is_some() => {
                        Ok(String::new())
                    }
                    Some(_) => Err("interrupted".to_owned()),
                    None => Err(failed()),
                };
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(40)),
        }
    };
    if file_access || result.is_err() {
        stop_child(&mut child, file_access);
    }
    let text = result?;
    let (task_copy, file_changes, ignored) = match copy {
        Some(copy) => copy.result()?,
        None => (None, None, false),
    };
    Ok(WritingReply {
        text,
        task_copy,
        file_changes,
        ignored_changes: ignored.then_some(true),
    })
}

fn codex_command(path: &Path, paths: &[PathBuf], isolate_children: bool) -> Command {
    let mut command = Command::new(path);
    if let Ok(path_env) = env::join_paths(paths) {
        command.env("PATH", path_env);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    if isolate_children {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(not(unix))]
    let _ = isolate_children;
    command
}

fn stop_child(child: &mut std::process::Child, isolate_children: bool) {
    #[cfg(unix)]
    if isolate_children {
        // The child started a separate process group. Stop its sandbox/tool descendants too.
        if let Ok(group) = i32::try_from(child.id()) {
            unsafe { libc::kill(-group, libc::SIGKILL) };
        }
    }
    #[cfg(not(unix))]
    let _ = isolate_children;
    let _ = child.kill();
    let _ = child.wait();
}

#[derive(Default)]
struct AgentOutput {
    line: Vec<u8>,
    bytes: u64,
    text: Option<String>,
    completed: bool,
}

impl AgentOutput {
    fn read(
        &mut self,
        reader: &mut BufReader<File>,
        events: Option<&Channel<AgentEvent>>,
    ) -> Result<(), String> {
        loop {
            let bytes = (&mut *reader)
                .take(MAX_OUTPUT - self.bytes + 1)
                .read_until(b'\n', &mut self.line)
                .map_err(|_| FAILED.to_owned())?;
            self.bytes += bytes as u64;
            if self.bytes > MAX_OUTPUT {
                return Err(FAILED.to_owned());
            }
            if bytes == 0 || self.line.last() != Some(&b'\n') {
                return Ok(());
            }
            if let Ok(event) = serde_json::from_slice::<Value>(&self.line) {
                match event["type"].as_str() {
                    Some("item.completed") if event["item"]["type"] == "agent_message" => {
                        if let Some(text) = event["item"]["text"]
                            .as_str()
                            .filter(|s| !s.trim().is_empty())
                        {
                            if let Some(events) = events {
                                let delta = if self.text.is_some() {
                                    format!("\n\n{text}")
                                } else {
                                    text.to_owned()
                                };
                                events
                                    .send(AgentEvent::Text { text: delta })
                                    .map_err(|_| "stopped")?;
                            }
                            self.text = Some(text.to_owned());
                        }
                    }
                    Some("turn.completed") => self.completed = true,
                    Some("turn.failed") => {
                        return Err(if self.text.is_some() {
                            "interrupted"
                        } else {
                            FAILED
                        }
                        .to_owned())
                    }
                    _ => {}
                }
            }
            self.line.clear();
        }
    }
}

fn temporary_input(input: &[u8], directory: &Path) -> std::io::Result<File> {
    use std::io::Write;
    let mut stdin = tempfile::tempfile_in(directory)?;
    stdin.write_all(input)?;
    stdin.rewind()?;
    Ok(stdin)
}
