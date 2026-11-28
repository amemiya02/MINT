//! Run the installed Codex CLI with its own sign-in. The scope MINT authorizes
//! is tied to the executable and the requested Codex policy, not the payload.
use crate::{app_data, app_data_dir, blocking};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::env;
use std::fs::{self, File};
use std::io::{Read, Seek};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const REGISTRY: &str = "external-agents.json";
const POLICY_REVISION: &str = "codex-exec-1";
static REGISTRY_LOCK: Mutex<()> = Mutex::new(());
const MAX_INPUT: usize = 256 * 1024;
const MAX_OUTPUT: u64 = 8 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(120);

const UNAVAILABLE: &str = "agentUnavailable";
const CHANGED: &str = "agentChanged";
const ACCESS_REQUIRED: &str = "agentAccessRequired";
const FAILED: &str = "agentFailed";

#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentAccess {
    ReadOnly,
    Configured,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WritingRequest {
    instruction: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    selected_text: Option<String>,
}

#[derive(Serialize)]
pub struct WritingReply {
    text: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAgent {
    path: PathBuf,
    revision: String,
    approved: Vec<AgentAccess>,
    verified: Vec<AgentAccess>,
    preferred_access: AgentAccess,
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
                _ => stored,
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
pub async fn send_external_agent(
    app: AppHandle,
    path: PathBuf,
    revision: String,
    access: AgentAccess,
    request: WritingRequest,
) -> Result<WritingReply, String> {
    blocking(move || {
        let current = restore(inspect(&path)?, registry(&app)?);
        same_revision(&current, &revision)?;
        if !current.approved.contains(&access) {
            return Err(ACCESS_REQUIRED.to_owned());
        }
        let reply = run_codex(&current.path, access, &request, cli_paths(&app))?;
        // Forgetting or replacing a connection during a request must not restore its access.
        let _ = update_registry(&app, |records| {
            if let Some(index) = records.iter().position(|stored| {
                stored.path == current.path
                    && stored.revision == revision
                    && stored.approved.contains(&access)
            }) {
                let mut stored = records.remove(index);
                if !stored.verified.contains(&access) {
                    stored.verified.push(access);
                }
                stored.preferred_access = access;
                records.insert(0, stored);
            }
            Ok(())
        });
        Ok(reply)
    })
    .await
}

/// Codex exec: https://learn.chatgpt.com/docs/non-interactive-mode
/// Arguments are fixed; the two task fields travel through stdin. Configured
/// mode deliberately leaves the CLI's policy in place, including its tools.
fn run_codex(
    path: &Path,
    access: AgentAccess,
    request: &WritingRequest,
    paths: Vec<PathBuf>,
) -> Result<WritingReply, String> {
    let failed = || FAILED.to_owned();
    let input = serde_json::to_vec(request).map_err(|_| failed())?;
    if request.instruction.trim().is_empty() || input.len() > MAX_INPUT {
        return Err(failed());
    }
    let scratch = tempfile::tempdir().map_err(|_| failed())?;
    // Anonymous files let the CLI read the prompt and write JSONL without pipe
    // backpressure or retaining named copies of either on disk.
    let stdin = temporary_input(&input).map_err(|_| failed())?;
    let mut stdout = tempfile::tempfile().map_err(|_| failed())?;
    let mut command = Command::new(path);
    command.args([
        "--ask-for-approval",
        "never",
        "exec",
        "--json",
        "--ephemeral",
        "--skip-git-repo-check",
    ]);
    if access == AgentAccess::ReadOnly {
        command.args([
            "--sandbox",
            "read-only",
            "--ignore-user-config",
            "--ignore-rules",
        ]);
    }
    if let Ok(path_env) = env::join_paths(paths) {
        command.env("PATH", path_env);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command
        .arg("-")
        .current_dir(scratch.path())
        .stdin(Stdio::from(stdin))
        .stdout(Stdio::from(stdout.try_clone().map_err(|_| failed())?))
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| failed())?;
    let start = Instant::now();
    loop {
        let status = child.try_wait();
        let output_ok = stdout.metadata().is_ok_and(|meta| meta.len() <= MAX_OUTPUT);
        match status {
            Ok(Some(status)) if status.success() && output_ok => break,
            Ok(Some(_)) => return Err(failed()),
            Ok(None) if output_ok && start.elapsed() < TIMEOUT => {
                std::thread::sleep(Duration::from_millis(40));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(failed());
            }
        }
    }
    stdout.rewind().map_err(|_| failed())?;
    let mut json_lines = String::new();
    stdout
        .take(MAX_OUTPUT)
        .read_to_string(&mut json_lines)
        .map_err(|_| failed())?;
    let mut text = None;
    let mut completed = false;
    for line in json_lines.lines() {
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match event["type"].as_str() {
            Some("item.completed") if event["item"]["type"] == "agent_message" => {
                if let Some(message) = event["item"]["text"].as_str() {
                    if !message.trim().is_empty() {
                        text = Some(message.to_owned());
                    }
                }
            }
            Some("turn.completed") => completed = true,
            Some("turn.failed") => return Err(failed()),
            _ => {}
        }
    }
    text.filter(|_| completed)
        .map(|text| WritingReply { text })
        .ok_or_else(failed)
}

fn temporary_input(input: &[u8]) -> std::io::Result<File> {
    use std::io::Write;
    let mut stdin = tempfile::tempfile()?;
    stdin.write_all(input)?;
    stdin.rewind()?;
    Ok(stdin)
}
