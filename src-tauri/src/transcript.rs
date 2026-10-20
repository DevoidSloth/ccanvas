// Live summary of a Claude Code session transcript for the agent widgets: how
// full the context window is, the session's names, and the last reply. The
// frontend polls it every few seconds for every agent on every tab.
//
// Transcripts are append-only JSONL and grow to hundreds of MB, so reading one
// whole on each poll (and shipping it to the webview to parse) swamped both
// main threads. Instead each file's summary is cached with the byte offset it
// has been read up to, and a poll parses only what was appended since.

use std::borrow::Cow;
use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// What was appended to `path` since `offset`, cut after its last newline (a
/// line still being written waits for the next read), plus the offset to
/// resume from. None when the file is now shorter than `offset`: it was
/// rewritten rather than appended to, so the caller should start over.
pub(crate) fn read_appended(path: &Path, offset: u64) -> io::Result<Option<(Vec<u8>, u64)>> {
    let mut f = File::open(path)?;
    let len = f.metadata()?.len();
    if len < offset {
        return Ok(None);
    }
    let mut buf = Vec::with_capacity((len - offset) as usize);
    if len > offset {
        f.seek(SeekFrom::Start(offset))?;
        f.take(len - offset).read_to_end(&mut buf)?;
    }
    let end = buf.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
    buf.truncate(end);
    Ok(Some((buf, offset + end as u64)))
}

/// `bytes` as text. Lossy decoding is many times slower than validating, so
/// it's only used when the bytes aren't valid UTF-8.
pub(crate) fn as_text(bytes: &[u8]) -> Cow<'_, str> {
    match std::str::from_utf8(bytes) {
        Ok(s) => Cow::Borrowed(s),
        Err(_) => String::from_utf8_lossy(bytes),
    }
}

#[derive(Clone, Serialize)]
pub struct Context {
    /// tokens in the context at the most recent reply
    used: u64,
    /// model id of that reply
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    /// largest context seen in this session (hints at a 1M window)
    peak: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    /// bytes read so far; changes whenever new events land
    version: u64,
    context: Option<Context>,
    /// newest `/rename` (a `custom-title` record)
    custom_title: Option<String>,
    /// the name Claude generated for the session (an `ai-title` record)
    ai_title: Option<String>,
    /// text of the latest turn's assistant replies
    last_reply: Option<String>,
}

#[derive(Default)]
struct Tracked {
    offset: u64,
    context: Option<Context>,
    peak: u64,
    custom_title: Option<String>,
    ai_title: Option<String>,
    /// text of each assistant reply since the last user event, oldest first
    reply: Vec<String>,
}

/// Just the event type, so a line we don't need is skipped without building it.
#[derive(Deserialize)]
struct Head {
    #[serde(rename = "type")]
    kind: Option<String>,
}

/// A top-level string field of a line, trimmed; None when missing or empty.
fn string_field(line: &str, field: &str) -> Option<String> {
    let v: Value = serde_json::from_str(line).ok()?;
    let s = v[field].as_str()?.trim();
    (!s.is_empty()).then(|| s.to_string())
}

impl Tracked {
    fn update(&mut self, path: &Path) -> io::Result<()> {
        let (bytes, next) = match read_appended(path, self.offset)? {
            Some(r) => r,
            // rewritten rather than appended to: start over
            None => {
                *self = Self::default();
                read_appended(path, 0)?.unwrap_or_default()
            }
        };
        for line in as_text(&bytes).lines() {
            self.apply(line);
        }
        self.offset = next;
        Ok(())
    }

    fn apply(&mut self, line: &str) {
        if line.contains(r#""type":"custom-title""#) {
            self.custom_title = string_field(line, "customTitle");
        }
        if line.contains(r#""type":"ai-title""#) {
            self.ai_title = string_field(line, "aiTitle");
        }
        if !line.contains(r#""type":"user""#) && !line.contains(r#""type":"assistant""#) {
            return;
        }
        let Ok(head) = serde_json::from_str::<Head>(line) else {
            return;
        };
        match head.kind.as_deref() {
            // a user message or tool result starts a new turn
            Some("user") => self.reply.clear(),
            Some("assistant") => {
                if let Ok(ev) = serde_json::from_str::<Value>(line) {
                    self.add_usage(&ev);
                    self.add_reply(&ev);
                }
            }
            _ => {}
        }
    }

    /// Context fill from a reply's token usage. Subagent (sidechain) turns have
    /// their own context and are skipped.
    fn add_usage(&mut self, ev: &Value) {
        let msg = &ev["message"];
        let u = &msg["usage"];
        if u.is_null() || ev["isSidechain"].as_bool() == Some(true) {
            return;
        }
        let model = msg["model"].as_str();
        if model == Some("<synthetic>") {
            return;
        }
        let used = [
            "input_tokens",
            "cache_read_input_tokens",
            "cache_creation_input_tokens",
            "output_tokens",
        ]
        .iter()
        .map(|k| u[k].as_u64().unwrap_or(0))
        .sum::<u64>();
        if used == 0 {
            return;
        }
        self.peak = self.peak.max(used);
        self.context = Some(Context {
            used,
            model: model.map(str::to_string),
            peak: 0,
        });
    }

    fn add_reply(&mut self, ev: &Value) {
        let content = &ev["message"]["content"];
        let text = match content {
            Value::String(s) => s.clone(),
            Value::Array(blocks) => blocks
                .iter()
                .filter(|b| b["type"] == "text")
                .filter_map(|b| b["text"].as_str().filter(|t| !t.is_empty()))
                .collect::<Vec<_>>()
                .join("\n"),
            _ => return,
        };
        let text = text.trim();
        if !text.is_empty() {
            self.reply.push(text.to_string());
        }
    }

    fn summary(&self) -> Summary {
        let reply = self.reply.join("\n\n");
        Summary {
            version: self.offset,
            context: self.context.clone().map(|c| Context { peak: self.peak, ..c }),
            custom_title: self.custom_title.clone(),
            ai_title: self.ai_title.clone(),
            last_reply: (!reply.is_empty()).then_some(reply),
        }
    }
}

fn cache() -> &'static Mutex<HashMap<PathBuf, Arc<Mutex<Tracked>>>> {
    static C: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<Tracked>>>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Summary of the transcript at `path` (None if it can't be read). The first
/// call for a file reads it whole; later ones read only what was appended.
#[tauri::command]
pub async fn transcript_summary(path: String) -> Option<Summary> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(path);
        let tracked = cache().lock().unwrap().entry(path.clone()).or_default().clone();
        let mut t = tracked.lock().unwrap();
        t.update(&path).ok()?;
        Some(t.summary())
    })
    .await
    .ok()
    .flatten()
}
