// Claude plan usage as Claude itself reports it (the numbers behind `/usage`):
// % of the 5-hour session limit and the weekly limits, with reset times.
//
// Uses the Claude Code sign-in the user already has: the OAuth credentials
// Claude Code keeps in the macOS Keychain ("Claude Code-credentials"), or in
// ~/.claude/.credentials.json on other platforms. The token is only ever sent
// to api.anthropic.com, is passed to curl on stdin (never on the command line),
// and is never logged or returned to the webview.
//
// The endpoint is internal to Claude Code and may change; any failure returns a
// status the UI can show while it falls back to the local token estimate.

use serde::Serialize;
use serde_json::Value;
use std::io::Write;
use std::process::{Command, Stdio};

use crate::usage::parse_iso_ms;

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Limit {
    /// e.g. "session", "weekly", "weekly_opus"
    kind: String,
    percent: f64,
    reset_ms: Option<i64>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlanUsage {
    /// "ok" | "signed_out" | "expired" | "error"
    status: String,
    /// plan name from the sign-in, e.g. "pro", "max"
    plan: Option<String>,
    limits: Vec<Limit>,
}

fn status(s: &str) -> PlanUsage {
    PlanUsage {
        status: s.into(),
        ..Default::default()
    }
}

fn read_credentials() -> Option<Value> {
    let raw = if cfg!(target_os = "macos") {
        let out = Command::new("security")
            .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
            .stderr(Stdio::null())
            .output()
            .ok()
            .filter(|o| o.status.success())?;
        String::from_utf8(out.stdout).ok()?
    } else {
        let home = std::env::var_os("HOME")?;
        std::fs::read_to_string(std::path::Path::new(&home).join(".claude/.credentials.json")).ok()?
    };
    serde_json::from_str(raw.trim()).ok()
}

fn fetch(token: &str) -> Option<Value> {
    let mut child = Command::new("curl")
        .args([
            "-sS",
            "-m",
            "15",
            "-K",
            "-",
            "-H",
            "anthropic-beta: oauth-2025-04-20",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    {
        let mut stdin = child.stdin.take()?;
        // curl config: keeps the token out of the process list
        write!(
            stdin,
            "url = \"{USAGE_URL}\"\nheader = \"Authorization: Bearer {token}\"\n"
        )
        .ok()?;
    }
    let out = child.wait_with_output().ok()?;
    if !out.status.success() {
        return None;
    }
    serde_json::from_slice(&out.stdout).ok()
}

fn limit(v: &Value, key: &str, kind: &str) -> Option<Limit> {
    let w = v.get(key)?;
    let percent = w.get("utilization")?.as_f64()?;
    Some(Limit {
        kind: kind.into(),
        percent,
        reset_ms: w.get("resets_at").and_then(Value::as_str).and_then(parse_iso_ms),
    })
}

#[tauri::command]
pub async fn claude_plan_usage() -> PlanUsage {
    // blocking work (Keychain + network) off the async runtime's core threads
    tauri::async_runtime::spawn_blocking(plan_usage)
        .await
        .unwrap_or_else(|_| status("error"))
}

fn plan_usage() -> PlanUsage {
    let Some(creds) = read_credentials() else {
        return status("signed_out");
    };
    let oauth = &creds["claudeAiOauth"];
    let Some(token) = oauth["accessToken"].as_str() else {
        return status("signed_out");
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    // Claude Code refreshes the token itself; until it does, we can't
    if oauth["expiresAt"].as_i64().is_some_and(|exp| exp <= now) {
        return status("expired");
    }
    let Some(body) = fetch(token) else {
        return status("error");
    };
    // an API error body (e.g. revoked token) has no usage windows
    if body.get("five_hour").is_none() && body.get("seven_day").is_none() {
        return status(if body.get("error").is_some() { "expired" } else { "error" });
    }
    let limits = [
        ("five_hour", "session"),
        ("seven_day", "weekly"),
        ("seven_day_opus", "weekly_opus"),
        ("seven_day_sonnet", "weekly_sonnet"),
    ]
    .iter()
    .filter_map(|(key, kind)| limit(&body, key, kind))
    .collect();
    PlanUsage {
        status: "ok".into(),
        plan: oauth["subscriptionType"].as_str().map(str::to_string),
        limits,
    }
}
