// Discovery of the Claude desktop app's Code-tab sessions, so ccanvas can mirror
// them. The app keeps one metadata file per session at
//   ~/Library/Application Support/Claude/claude-code-sessions/<org>/<account>/local_<uuid>.json
// and the CLI session it wraps writes its transcript to
//   ~/.claude/projects/<encoded-cwd>/<cliSessionId>.jsonl
//
// This is an internal, undocumented format of another app (macOS only). ALL of
// the parsing lives in this one module, so if the format changes this is the
// only place that breaks — the frontend sees just the `DesktopSession` shape.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One desktop-app session, as the picker and mirror widget need it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSession {
    /// the desktop app's own id (`local_<uuid>`)
    session_id: String,
    /// the Claude Code session id — names the transcript file
    cli_session_id: String,
    cwd: String,
    title: String,
    model: Option<String>,
    is_archived: bool,
    /// epoch milliseconds
    created_at: Option<u64>,
    /// epoch milliseconds
    last_activity_at: Option<u64>,
    /// absolute path of the transcript (it may not exist)
    transcript_path: String,
    /// transcript modification time in epoch milliseconds; None if it's missing
    transcript_mtime: Option<u64>,
}

/// The fields we read from a session file; everything else is skipped without
/// being built. Each is a loose `Value` so a field of an unexpected type costs
/// only that field, not the whole session.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    session_id: Option<Value>,
    cli_session_id: Option<Value>,
    cwd: Option<Value>,
    title: Option<Value>,
    model: Option<Value>,
    is_archived: Option<Value>,
    created_at: Option<Value>,
    last_activity_at: Option<Value>,
}

/// A non-empty, trimmed string.
fn text(v: Option<Value>) -> Option<String> {
    let s = v?.as_str()?.trim().to_string();
    (!s.is_empty()).then_some(s)
}

/// Epoch milliseconds, whether written as an integer or a float.
fn millis(v: Option<Value>) -> Option<u64> {
    let v = v?;
    v.as_u64()
        .or_else(|| v.as_f64().filter(|f| *f >= 0.0).map(|f| f as u64))
}

/// Claude Code's project folder name for a working directory: every character
/// outside [A-Za-z0-9] becomes a dash. JavaScript's `replace` works per UTF-16
/// unit, so a character outside the BMP counts as two dashes — match that so
/// this agrees with `encodeProject` in src/lib/transcript.ts.
fn encode_project(cwd: &str) -> String {
    let mut out = String::with_capacity(cwd.len());
    for c in cwd.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else {
            for _ in 0..c.len_utf16() {
                out.push('-');
            }
        }
    }
    out
}

fn transcript_path(home: &Path, cwd: &str, cli_session_id: &str) -> PathBuf {
    home.join(".claude")
        .join("projects")
        .join(encode_project(cwd))
        .join(format!("{cli_session_id}.jsonl"))
}

fn mtime_ms(path: &Path) -> Option<u64> {
    let t = fs::metadata(path).ok()?.modified().ok()?;
    Some(t.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

/// Parse one session file's text. None when it isn't JSON or lacks the ids and
/// working directory a mirror needs.
fn parse_session(home: &Path, body: &str) -> Option<DesktopSession> {
    let m: Meta = serde_json::from_str(body).ok()?;
    let session_id = text(m.session_id)?;
    let cli_session_id = text(m.cli_session_id)?;
    let cwd = text(m.cwd)?;
    let path = transcript_path(home, &cwd, &cli_session_id);
    Some(DesktopSession {
        title: text(m.title).unwrap_or_else(|| "Untitled session".to_string()),
        model: text(m.model),
        is_archived: m.is_archived.and_then(|v| v.as_bool()).unwrap_or(false),
        created_at: millis(m.created_at),
        last_activity_at: millis(m.last_activity_at),
        transcript_mtime: mtime_ms(&path),
        transcript_path: path.to_string_lossy().into_owned(),
        session_id,
        cli_session_id,
        cwd,
    })
}

/// Parsed session files, keyed by path and checked against the file's mtime
/// and size. The picker rescans every few seconds and the files hold large
/// blobs we don't read (hundreds of files, ~17 MB in all), so only files that
/// changed are parsed again.
type Stamp = (SystemTime, u64);
type ParsedCache = Mutex<HashMap<PathBuf, (Stamp, Option<DesktopSession>)>>;
fn parsed_cache() -> &'static ParsedCache {
    static C: OnceLock<ParsedCache> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// One session file, parsed or from the cache, with a fresh transcript mtime.
fn load_session(home: &Path, path: &Path) -> Option<DesktopSession> {
    let meta = fs::metadata(path).ok()?;
    let stamp = (meta.modified().ok()?, meta.len());
    let hit = parsed_cache()
        .lock()
        .unwrap()
        .get(path)
        .filter(|(s, _)| *s == stamp)
        .map(|(_, d)| d.clone());
    let parsed = match hit {
        Some(d) => d,
        None => {
            let d = fs::read_to_string(path)
                .ok()
                .and_then(|t| parse_session(home, &t));
            parsed_cache()
                .lock()
                .unwrap()
                .insert(path.to_path_buf(), (stamp, d.clone()));
            d
        }
    };
    let mut s = parsed?;
    s.transcript_mtime = mtime_ms(Path::new(&s.transcript_path));
    Some(s)
}

/// Subdirectories of `dir` (unreadable ones are skipped).
fn subdirs(dir: &Path) -> Vec<PathBuf> {
    fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect()
}

/// Every session under `sessions_root` (`.../claude-code-sessions`), newest
/// activity first. Missing directories and malformed files yield nothing.
fn scan(home: &Path, sessions_root: &Path) -> Vec<DesktopSession> {
    let mut out = Vec::new();
    for org in subdirs(sessions_root) {
        for account in subdirs(&org) {
            for entry in fs::read_dir(&account).into_iter().flatten().flatten() {
                let path = entry.path();
                let is_session = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("local_") && n.ends_with(".json"));
                if !is_session {
                    continue;
                }
                if let Some(s) = load_session(home, &path) {
                    out.push(s);
                }
            }
        }
    }
    // most recent activity first. The metadata's lastActivityAt lags a session
    // that is mid-turn, so the transcript's mtime counts too (whichever is
    // newer); then creation time, then the id so the order is stable
    out.sort_by(|a, b| {
        let key = |s: &DesktopSession| {
            s.last_activity_at
                .max(s.transcript_mtime)
                .or(s.created_at)
                .unwrap_or(0)
        };
        key(b)
            .cmp(&key(a))
            .then_with(|| a.session_id.cmp(&b.session_id))
    });
    out
}

fn sessions_root(home: &Path) -> PathBuf {
    home.join("Library")
        .join("Application Support")
        .join("Claude")
        .join("claude-code-sessions")
}

/// The desktop app's sessions, newest activity first. Empty when the app isn't
/// installed (or this isn't macOS).
#[tauri::command]
pub async fn desktop_sessions() -> Vec<DesktopSession> {
    tauri::async_runtime::spawn_blocking(|| {
        let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
            return Vec::new();
        };
        scan(&home, &sessions_root(&home))
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const FULL: &str = r#"{
        "sessionId": "local_aaa",
        "cliSessionId": "11111111-2222-3333-4444-555555555555",
        "cwd": "/Users/me/p/my.project",
        "title": "  Literature review  ",
        "model": "claude-sonnet-5-5",
        "isArchived": true,
        "createdAt": 1000,
        "lastActivityAt": 5000,
        "someFutureField": {"nested": [1, 2, 3]}
    }"#;

    /// A scratch directory under the system temp dir, removed on drop.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!("ccanvas-ds-{tag}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&p);
            fs::create_dir_all(&p).unwrap();
            Scratch(p)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn parses_full_session() {
        let home = Path::new("/home/x");
        let s = parse_session(home, FULL).unwrap();
        assert_eq!(s.session_id, "local_aaa");
        assert_eq!(s.title, "Literature review");
        assert_eq!(s.model.as_deref(), Some("claude-sonnet-5-5"));
        assert!(s.is_archived);
        assert_eq!(s.created_at, Some(1000));
        assert_eq!(s.last_activity_at, Some(5000));
        assert_eq!(
            s.transcript_path,
            "/home/x/.claude/projects/-Users-me-p-my-project/11111111-2222-3333-4444-555555555555.jsonl"
        );
        assert_eq!(s.transcript_mtime, None);
    }

    #[test]
    fn tolerates_missing_optional_fields() {
        let s = parse_session(
            Path::new("/h"),
            r#"{"sessionId":"local_b","cliSessionId":"c","cwd":"/a/b"}"#,
        )
        .unwrap();
        assert_eq!(s.title, "Untitled session");
        assert_eq!(s.model, None);
        assert!(!s.is_archived);
        assert_eq!(s.last_activity_at, None);
    }

    #[test]
    fn rejects_sessions_without_ids_or_cwd() {
        let h = Path::new("/h");
        assert!(parse_session(h, "not json").is_none());
        assert!(parse_session(h, "[]").is_none());
        assert!(parse_session(h, r#"{"sessionId":"local_b","cwd":"/a"}"#).is_none());
        assert!(parse_session(h, r#"{"cliSessionId":"c","cwd":"/a"}"#).is_none());
        assert!(parse_session(h, r#"{"sessionId":"l","cliSessionId":"c"}"#).is_none());
        // wrong types are malformed, not a panic
        assert!(parse_session(h, r#"{"sessionId":1,"cliSessionId":"c","cwd":"/a"}"#).is_none());
        assert!(parse_session(h, r#"{"sessionId":"l","cliSessionId":null,"cwd":"/a"}"#).is_none());
    }

    #[test]
    fn odd_field_types_cost_only_that_field() {
        let s = parse_session(
            Path::new("/h"),
            r#"{"sessionId":"l","cliSessionId":"c","cwd":"/a","title":7,"model":null,
                "isArchived":"yes","createdAt":1.5e3,"lastActivityAt":"soon"}"#,
        )
        .unwrap();
        assert_eq!(s.title, "Untitled session");
        assert_eq!(s.model, None);
        assert!(!s.is_archived);
        assert_eq!(s.created_at, Some(1500));
        assert_eq!(s.last_activity_at, None);
    }

    #[test]
    fn encodes_cwd_like_the_frontend() {
        assert_eq!(encode_project("/Users/me/p/my-app"), "-Users-me-p-my-app");
        assert_eq!(encode_project("/a b/c_d.e"), "-a-b-c-d-e");
        // é is one UTF-16 unit, 😀 is two
        assert_eq!(encode_project("é😀x"), "---x");
    }

    #[test]
    fn missing_directory_is_empty() {
        let s = Scratch::new("missing");
        assert!(scan(&s.0, &s.0.join("nope")).is_empty());
    }

    #[test]
    fn scans_sorts_and_skips_junk() {
        let s = Scratch::new("scan");
        let root = s.0.join("sessions");
        let acct = root.join("org").join("acct");
        fs::create_dir_all(&acct).unwrap();
        let mk = |name: &str, body: &str| fs::write(acct.join(name), body).unwrap();
        mk(
            "local_old.json",
            r#"{"sessionId":"local_old","cliSessionId":"c1","cwd":"/p/one","lastActivityAt":100}"#,
        );
        mk(
            "local_new.json",
            r#"{"sessionId":"local_new","cliSessionId":"c2","cwd":"/p/two","lastActivityAt":900}"#,
        );
        mk(
            "local_nodate.json",
            r#"{"sessionId":"local_nodate","cliSessionId":"c3","cwd":"/p/three"}"#,
        );
        mk("local_bad.json", "{ truncated");
        mk(
            "notes.json",
            r#"{"sessionId":"x","cliSessionId":"y","cwd":"/z"}"#,
        );
        mk("archived-sessions.idx", "junk");
        fs::write(root.join("stray-file"), "x").unwrap();
        fs::create_dir_all(root.join("org").join("deleted_1")).unwrap();

        // the session with the OLDEST lastActivityAt has a transcript written
        // just now, so it is the most recently active and sorts first
        let tdir = s.0.join(".claude").join("projects").join("-p-one");
        fs::create_dir_all(&tdir).unwrap();
        fs::write(tdir.join("c1.jsonl"), "{}\n").unwrap();

        let got = scan(&s.0, &root);
        let ids: Vec<_> = got.iter().map(|d| d.session_id.as_str()).collect();
        assert_eq!(ids, ["local_old", "local_new", "local_nodate"]);
        assert!(got[0].transcript_mtime.is_some());
        assert!(got[1].transcript_mtime.is_none());
    }
}
