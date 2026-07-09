// Embedded local media server for the desktop app. Streams local files with
// HTTP Range support and transcodes exotic codecs to browser-playable fMP4 via
// ffmpeg — so the packaged/`npm run app` desktop build plays video entirely on
// its own, with no separate Node backend running.
//
// Hand-rolled on std::net so it needs no extra crates. Bound to a random
// loopback port at startup; the frontend gets the URL via the `media_info`
// command and points <video> at it (or at the asset protocol for direct play).

use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::thread;

static PORT: OnceLock<u16> = OnceLock::new();
static HAS_FFMPEG: OnceLock<bool> = OnceLock::new();

fn ffmpeg_bin() -> String {
    std::env::var("CCANVAS_FFMPEG").unwrap_or_else(|_| "ffmpeg".into())
}
fn ffprobe_bin() -> String {
    std::env::var("CCANVAS_FFPROBE").unwrap_or_else(|_| "ffprobe".into())
}

// keep spawned ffmpeg/ffprobe from flashing a console window on Windows
#[cfg(windows)]
fn quiet(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
}
#[cfg(not(windows))]
fn quiet(_cmd: &mut Command) {}

/// Is ffmpeg available (checked once via `ffprobe -version`)?
pub fn has_ffmpeg() -> bool {
    *HAS_FFMPEG.get_or_init(|| {
        let mut cmd = Command::new(ffprobe_bin());
        cmd.arg("-version")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        quiet(&mut cmd);
        cmd.status().map(|s| s.success()).unwrap_or(false)
    })
}

/// Base URL of the embedded server once started, e.g. http://127.0.0.1:52341.
pub fn base_url() -> Option<String> {
    PORT.get().map(|p| format!("http://127.0.0.1:{p}"))
}

/// Start the server once, on a background thread. Non-fatal on failure.
pub fn start() {
    if PORT.get().is_some() {
        return;
    }
    let listener = match TcpListener::bind("127.0.0.1:0") {
        Ok(l) => l,
        Err(_) => return,
    };
    let port = match listener.local_addr() {
        Ok(a) => a.port(),
        Err(_) => return,
    };
    let _ = PORT.set(port);
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            thread::spawn(move || {
                let _ = handle(stream);
            });
        }
    });
}

fn handle(stream: TcpStream) -> std::io::Result<()> {
    let mut writer = stream.try_clone()?;
    let mut reader = BufReader::new(stream);

    let mut request_line = String::new();
    if reader.read_line(&mut request_line)? == 0 {
        return Ok(());
    }
    let target = request_line
        .split_whitespace()
        .nth(1)
        .unwrap_or("")
        .to_string();

    // consume headers, capturing Range
    let mut range: Option<String> = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        let t = line.trim_end();
        if t.is_empty() {
            break;
        }
        if let Some((k, v)) = t.split_once(':') {
            if k.trim().eq_ignore_ascii_case("range") {
                range = Some(v.trim().to_string());
            }
        }
    }

    let (path, query) = target.split_once('?').unwrap_or((target.as_str(), ""));
    match path {
        "/health" => write_json(&mut writer, "{\"ok\":true}"),
        "/file" => serve_file(&mut writer, query, range.as_deref()),
        "/probe" => serve_probe(&mut writer, query),
        "/transcode" => serve_transcode(&mut writer, query),
        _ => write_simple(&mut writer, 404, "not found"),
    }
}

// ---------- responses ----------

fn reason(code: u16) -> &'static str {
    match code {
        200 => "OK",
        206 => "Partial Content",
        400 => "Bad Request",
        404 => "Not Found",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        _ => "OK",
    }
}

fn write_simple(w: &mut TcpStream, code: u16, msg: &str) -> std::io::Result<()> {
    let body = msg.as_bytes();
    let head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: text/plain\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        code,
        reason(code),
        body.len()
    );
    w.write_all(head.as_bytes())?;
    w.write_all(body)
}

fn write_json(w: &mut TcpStream, json: &str) -> std::io::Result<()> {
    let body = json.as_bytes();
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    w.write_all(head.as_bytes())?;
    w.write_all(body)
}

// ---------- routes ----------

fn serve_file(w: &mut TcpStream, query: &str, range: Option<&str>) -> std::io::Result<()> {
    let path = match query_get(query, "path") {
        Some(p) => p,
        None => return write_simple(w, 400, "missing path"),
    };
    let mut file = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(_) => return write_simple(w, 404, "not found"),
    };
    let total = file.metadata().map(|m| m.len()).unwrap_or(0);
    let ctype = media_type(&path);

    if total == 0 {
        let head = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {ctype}\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        return w.write_all(head.as_bytes());
    }

    let (start, end, partial) = match range.and_then(|r| parse_range(r, total)) {
        Some((s, e)) => (s, e, true),
        None => (0, total - 1, false),
    };
    let len = end - start + 1;

    let mut head = String::new();
    if partial {
        head.push_str(&format!(
            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {start}-{end}/{total}\r\n"
        ));
    } else {
        head.push_str("HTTP/1.1 200 OK\r\n");
    }
    head.push_str(&format!(
        "Content-Type: {ctype}\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-cache\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n"
    ));
    w.write_all(head.as_bytes())?;

    file.seek(SeekFrom::Start(start))?;
    let mut remaining = len;
    let mut buf = [0u8; 64 * 1024];
    while remaining > 0 {
        let want = remaining.min(buf.len() as u64) as usize;
        let n = file.read(&mut buf[..want])?;
        if n == 0 {
            break;
        }
        if w.write_all(&buf[..n]).is_err() {
            break; // client went away
        }
        remaining -= n as u64;
    }
    Ok(())
}

fn serve_probe(w: &mut TcpStream, query: &str) -> std::io::Result<()> {
    let path = match query_get(query, "path") {
        Some(p) => p,
        None => return write_simple(w, 400, "missing path"),
    };
    let empty = "{\"duration\":null,\"hasVideo\":false,\"format\":null,\"video\":null,\"audio\":null,\"streams\":[]}";
    let mut cmd = Command::new(ffprobe_bin());
    cmd.args([
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
    ])
    .arg(&path)
    .stderr(Stdio::null());
    quiet(&mut cmd);
    let json = match cmd.output() {
        Ok(o) if o.status.success() => match serde_json::from_slice::<serde_json::Value>(&o.stdout)
        {
            Ok(v) => summarize_probe(&v).to_string(),
            Err(_) => empty.to_string(),
        },
        _ => empty.to_string(),
    };
    write_json(w, &json)
}

// Distil raw ffprobe JSON into the media-info shape the widget's info panel
// shows (codec, resolution, fps, frame count, bitrate, audio, container, …).
fn summarize_probe(v: &serde_json::Value) -> serde_json::Value {
    use serde_json::json;
    let fmt = v.get("format");
    let streams = v.get("streams").and_then(|s| s.as_array());
    let find = |t: &str| {
        streams.and_then(|arr| {
            arr.iter()
                .find(|s| s.get("codec_type").and_then(|c| c.as_str()) == Some(t))
        })
    };
    let num = |x: Option<&serde_json::Value>| -> Option<f64> {
        x.and_then(|x| {
            x.as_f64()
                .or_else(|| x.as_str().and_then(|s| s.parse::<f64>().ok()))
        })
    };
    let text = |x: Option<&serde_json::Value>| -> Option<String> {
        x.and_then(|x| x.as_str().map(|s| s.to_string()))
    };
    let fps = |s: &serde_json::Value| -> Option<f64> {
        let r = s
            .get("avg_frame_rate")
            .and_then(|x| x.as_str())
            .filter(|&r| r != "0/0")
            .or_else(|| s.get("r_frame_rate").and_then(|x| x.as_str()))?;
        let (n, d) = r.split_once('/')?;
        let (n, d): (f64, f64) = (n.parse().ok()?, d.parse().ok()?);
        if d != 0.0 {
            Some(n / d)
        } else {
            None
        }
    };

    let lang = |s: &serde_json::Value| -> Option<String> {
        s.get("tags")
            .and_then(|t| t.get("language"))
            .and_then(|x| x.as_str())
            .map(|x| x.to_string())
    };
    let duration = num(fmt.and_then(|f| f.get("duration")));
    let vid = find("video");
    let aud = find("audio");

    let video = vid.map(|s| {
        let f = fps(s);
        let mut frames = num(s.get("nb_frames"));
        if frames.is_none() {
            if let (Some(fp), Some(du)) = (f, duration) {
                frames = Some((fp * du).round());
            }
        }
        json!({
            "codec": text(s.get("codec_name")),
            "codecLong": text(s.get("codec_long_name")),
            "profile": text(s.get("profile")),
            "level": s.get("level").and_then(|x| x.as_i64()).filter(|&l| l > 0),
            "width": s.get("width").and_then(|x| x.as_u64()),
            "height": s.get("height").and_then(|x| x.as_u64()),
            "codedWidth": s.get("coded_width").and_then(|x| x.as_u64()),
            "codedHeight": s.get("coded_height").and_then(|x| x.as_u64()),
            "fps": f,
            "frames": frames,
            "pixFmt": text(s.get("pix_fmt")),
            "bitDepth": num(s.get("bits_per_raw_sample")),
            "bitRate": num(s.get("bit_rate")),
            "aspect": text(s.get("display_aspect_ratio")),
            "sar": text(s.get("sample_aspect_ratio")),
            "colorSpace": text(s.get("color_space")),
            "colorRange": text(s.get("color_range")),
            "colorPrimaries": text(s.get("color_primaries")),
            "colorTransfer": text(s.get("color_transfer")),
            "fieldOrder": text(s.get("field_order")),
            "language": lang(s),
        })
    });
    let audio = aud.map(|s| {
        json!({
            "codec": text(s.get("codec_name")),
            "codecLong": text(s.get("codec_long_name")),
            "profile": text(s.get("profile")),
            "channels": s.get("channels").and_then(|x| x.as_u64()),
            "channelLayout": text(s.get("channel_layout")),
            "sampleRate": num(s.get("sample_rate")),
            "bitsPerSample": num(s.get("bits_per_sample")).filter(|&b| b > 0.0),
            "bitRate": num(s.get("bit_rate")),
            "language": lang(s),
        })
    });
    let stream_list: Vec<serde_json::Value> = streams
        .map(|arr| {
            arr.iter()
                .map(|s| {
                    let mut bits: Vec<String> = Vec::new();
                    if let Some(t) = s.get("codec_type").and_then(|x| x.as_str()) {
                        bits.push(t.to_string());
                    }
                    if let Some(c) = s.get("codec_name").and_then(|x| x.as_str()) {
                        bits.push(c.to_string());
                    }
                    if let Some(l) = lang(s) {
                        bits.push(format!("[{l}]"));
                    }
                    if let Some(title) = s
                        .get("tags")
                        .and_then(|t| t.get("title"))
                        .and_then(|x| x.as_str())
                    {
                        bits.push(format!("\"{title}\""));
                    }
                    if let Some(cl) = s.get("channel_layout").and_then(|x| x.as_str()) {
                        bits.push(cl.to_string());
                    }
                    if let (Some(w), Some(h)) = (
                        s.get("width").and_then(|x| x.as_u64()),
                        s.get("height").and_then(|x| x.as_u64()),
                    ) {
                        bits.push(format!("{w}×{h}"));
                    }
                    json!({
                        "index": s.get("index").and_then(|x| x.as_u64()),
                        "type": text(s.get("codec_type")),
                        "codec": text(s.get("codec_name")),
                        "label": bits.join(" "),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    json!({
        "duration": duration,
        "hasVideo": vid.is_some(),
        "format": fmt.map(|f| json!({
            "name": text(f.get("format_name")),
            "longName": text(f.get("format_long_name")),
            "bitRate": num(f.get("bit_rate")),
            "size": num(f.get("size")),
            "nbStreams": f.get("nb_streams").and_then(|x| x.as_u64()),
            "startTime": num(f.get("start_time")),
            "tags": f.get("tags").cloned(),
        })),
        "video": video,
        "audio": audio,
        "streams": stream_list,
    })
}

fn serve_transcode(w: &mut TcpStream, query: &str) -> std::io::Result<()> {
    let path = match query_get(query, "path") {
        Some(p) => p,
        None => return write_simple(w, 400, "missing path"),
    };
    let start = query_get(query, "start")
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);

    let mut cmd = Command::new(ffmpeg_bin());
    if start > 0.0 {
        cmd.args(["-ss", &start.to_string()]);
    }
    cmd.arg("-i").arg(&path);
    cmd.args([
        "-map",
        "0:v:0?",
        "-map",
        "0:a:0?",
        "-sn",
        "-dn",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-vf",
        "scale='min(1920,iw)':-2",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-ac",
        "2",
        "-movflags",
        "frag_keyframe+empty_moov+default_base_moof",
        "-f",
        "mp4",
        "pipe:1",
    ]);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    quiet(&mut cmd);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => return write_simple(w, 501, "ffmpeg not available"),
    };
    let mut stdout = match child.stdout.take() {
        Some(o) => o,
        None => {
            let _ = child.kill();
            return write_simple(w, 500, "no output");
        }
    };

    // unknown-length body: stream until ffmpeg ends, then close the connection
    let head = "HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n";
    if w.write_all(head.as_bytes()).is_err() {
        let _ = child.kill();
        let _ = child.wait();
        return Ok(());
    }

    let mut buf = [0u8; 64 * 1024];
    loop {
        match stdout.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if w.write_all(&buf[..n]).is_err() {
                    break; // client seeked/closed → stop transcoding
                }
            }
            Err(_) => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    Ok(())
}

// ---------- helpers ----------

fn query_get(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        if k == key {
            return Some(percent_decode(v));
        }
    }
    None
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => match (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                (Some(h), Some(l)) => {
                    out.push(h * 16 + l);
                    i += 3;
                }
                _ => {
                    out.push(bytes[i]);
                    i += 1;
                }
            },
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

// `bytes=start-end`, `bytes=start-`, or suffix `bytes=-N`. Returns (start, end).
fn parse_range(h: &str, total: u64) -> Option<(u64, u64)> {
    let rest = h.trim().strip_prefix("bytes=")?;
    let (s, e) = rest.split_once('-')?;
    let (s, e) = (s.trim(), e.trim());
    if total == 0 {
        return None;
    }
    let last = total - 1;
    if s.is_empty() {
        let n: u64 = e.parse().ok()?;
        if n == 0 {
            return None;
        }
        return Some((total.saturating_sub(n), last));
    }
    let start: u64 = s.parse().ok()?;
    let end: u64 = if e.is_empty() {
        last
    } else {
        e.parse::<u64>().ok()?.min(last)
    };
    if start > end || start > last {
        return None;
    }
    Some((start, end))
}

fn media_type(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "mp4" | "m4v" | "m4p" => "video/mp4",
        "webm" => "video/webm",
        "ogv" | "ogg" => "video/ogg",
        "mov" | "qt" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "wmv" => "video/x-ms-wmv",
        "asf" => "video/x-ms-asf",
        "flv" => "video/x-flv",
        "f4v" => "video/x-f4v",
        "mpg" | "mpeg" | "vob" => "video/mpeg",
        "mts" | "m2ts" => "video/mp2t",
        "3gp" => "video/3gpp",
        "3g2" => "video/3gpp2",
        _ => "application/octet-stream",
    }
}

// ---------- command exposed to the frontend ----------

/// The embedded media server's base URL + whether ffmpeg transcoding is
/// available. The video widget uses this to stream/transcode local files.
#[tauri::command]
pub fn media_info() -> serde_json::Value {
    serde_json::json!({
        "url": base_url(),
        "ffmpeg": has_ffmpeg(),
    })
}
