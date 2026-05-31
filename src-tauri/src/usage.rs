// Claude Code usage, read from the session transcripts it writes under
// ~/.claude/projects/**/*.jsonl. Each assistant line carries a `message.usage`
// block + an ISO `timestamp`; we sum tokens into the active 5-hour rate-limit
// window (and the last 24h) the same way `ccusage` does.

use serde::Serialize;
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const FIVE_H_MS: i64 = 5 * 3600 * 1000;
const HOUR_MS: i64 = 3600 * 1000;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeUsage {
    has_data: bool,
    /// tokens used in the current 5-hour window
    active_tokens: u64,
    /// epoch ms when the current window resets (null if no active window)
    reset_ms: Option<i64>,
    /// tokens used in the last rolling 24h
    day_tokens: u64,
    /// messages in the active window
    messages: u64,
}

// days since 1970-01-01 (Howard Hinnant's algorithm) — avoids a date dependency
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

// parse `YYYY-MM-DDTHH:MM:SS(.sss)?Z` (always UTC) → epoch ms
fn parse_iso_ms(s: &str) -> Option<i64> {
    if s.len() < 19 {
        return None;
    }
    let n = |a: usize, len: usize| -> Option<i64> { s.get(a..a + len)?.parse().ok() };
    let (y, mo, d) = (n(0, 4)?, n(5, 2)?, n(8, 2)?);
    let (h, mi, se) = (n(11, 2)?, n(14, 2)?, n(17, 2)?);
    let mut ms = 0i64;
    if s.as_bytes().get(19) == Some(&b'.') {
        let frac: String = s[20..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .take(3)
            .collect();
        if !frac.is_empty() {
            ms = format!("{:0<3}", frac).parse().unwrap_or(0);
        }
    }
    let days = days_from_civil(y, mo, d);
    Some((days * 86400 + h * 3600 + mi * 60 + se) * 1000 + ms)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[tauri::command]
pub fn claude_usage(app: AppHandle) -> ClaudeUsage {
    let Ok(home) = app.path().home_dir() else {
        return ClaudeUsage::default();
    };
    let root = home.join(".claude").join("projects");
    let now = now_ms();
    // only files touched recently can hold entries inside our windows
    let cutoff = now - 25 * HOUR_MS;

    let mut entries: Vec<(i64, u64)> = Vec::new();
    if let Ok(projects) = fs::read_dir(&root) {
        for proj in projects.flatten() {
            let pdir = proj.path();
            if !pdir.is_dir() {
                continue;
            }
            let Ok(files) = fs::read_dir(&pdir) else {
                continue;
            };
            for f in files.flatten() {
                let fp = f.path();
                if fp.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                let recent = f
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64 >= cutoff)
                    .unwrap_or(true);
                if !recent {
                    continue;
                }
                let Ok(content) = fs::read_to_string(&fp) else {
                    continue;
                };
                for line in content.lines() {
                    if !line.contains("\"usage\"") {
                        continue;
                    }
                    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
                        continue;
                    };
                    let u = &v["message"]["usage"];
                    if u.is_null() {
                        continue;
                    }
                    // count new work (input + output + cache writes); cache
                    // *reads* are cheap and re-counted every turn, so excluding
                    // them keeps the number a meaningful usage signal
                    let tok = u["input_tokens"].as_u64().unwrap_or(0)
                        + u["output_tokens"].as_u64().unwrap_or(0)
                        + u["cache_creation_input_tokens"].as_u64().unwrap_or(0);
                    if tok == 0 {
                        continue;
                    }
                    if let Some(ts) = v["timestamp"].as_str().and_then(parse_iso_ms) {
                        if ts >= cutoff {
                            entries.push((ts, tok));
                        }
                    }
                }
            }
        }
    }

    if entries.is_empty() {
        return ClaudeUsage::default();
    }
    entries.sort_by_key(|e| e.0);

    let day_cut = now - 24 * HOUR_MS;
    let day_tokens: u64 = entries.iter().filter(|e| e.0 >= day_cut).map(|e| e.1).sum();

    // group into 5-hour blocks; a new block starts on a >5h gap or once 5h
    // have elapsed since the block's first message
    let mut block_start = entries[0].0;
    let mut block_tokens = 0u64;
    let mut block_msgs = 0u64;
    let mut prev = entries[0].0;
    for &(ts, tok) in &entries {
        if ts - block_start >= FIVE_H_MS || ts - prev > FIVE_H_MS {
            block_start = ts;
            block_tokens = 0;
            block_msgs = 0;
        }
        block_tokens += tok;
        block_msgs += 1;
        prev = ts;
    }

    let reset = block_start + FIVE_H_MS;
    if now >= reset {
        // the window has already rolled over — nothing active
        return ClaudeUsage {
            has_data: true,
            day_tokens,
            ..Default::default()
        };
    }

    ClaudeUsage {
        has_data: true,
        active_tokens: block_tokens,
        reset_ms: Some(reset),
        day_tokens,
        messages: block_msgs,
    }
}
