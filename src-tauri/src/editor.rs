// VS Code in a widget: run `code serve-web` for a folder and hand the frontend
// a localhost URL to embed. One server per folder, reused while it lives, and
// all of them are killed when the app exits.
//
// `code serve-web` refuses to be framed (`X-Frame-Options: SAMEORIGIN` and
// `frame-ancestors 'self'`), which shows up as a blank white widget. So the
// widget talks to a tiny local proxy instead, which strips those two headers
// and re-attaches VS Code's SameSite=Strict secret cookie that the browser
// won't send from inside a cross-origin frame.

use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

struct Server {
    /// port of `code serve-web` itself
    upstream: u16,
    /// port of the framing proxy the widget loads
    proxy: u16,
    stop: Arc<AtomicBool>,
    child: Child,
}

impl Server {
    fn kill(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // wake the accept loop so it notices the stop flag
        let _ = TcpStream::connect(("127.0.0.1", self.proxy));
        kill_tree(&mut self.child);
    }
}

fn servers() -> &'static Mutex<HashMap<String, Server>> {
    static S: OnceLock<Mutex<HashMap<String, Server>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Serialize)]
pub struct CodeServer {
    pub url: String,
    pub port: u16,
    /// true when this call started the server (rather than reusing one)
    pub started: bool,
}

/// `code` is a shell script that launches the CLI, which launches node — killing
/// only the direct child orphans the rest, so the server runs in its own
/// process group and the whole group is signalled.
fn kill_tree(child: &mut Child) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &format!("-{}", child.id())])
            .status();
    }
    let _ = child.kill();
    let _ = child.try_wait();
}

/// Where the `code` CLI lives. GUI apps don't inherit a login shell's PATH, so
/// ask the login shell first, then fall back to the usual install locations.
fn code_binary() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    if let Ok(out) = Command::new(&shell).args(["-lc", "command -v code"]).output() {
        let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !path.is_empty() && std::path::Path::new(&path).exists() {
            return Some(path);
        }
    }
    for candidate in [
        "/usr/local/bin/code",
        "/opt/homebrew/bin/code",
        "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
    ] {
        if std::path::Path::new(candidate).exists() {
            return Some(candidate.to_string());
        }
    }
    None
}

fn free_port() -> Result<u16, String> {
    let l = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    l.local_addr().map(|a| a.port()).map_err(|e| e.to_string())
}

fn listening(port: u16) -> bool {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_millis(250),
    )
    .is_ok()
}

fn url_for(port: u16, dir: &str) -> String {
    // ?folder= opens the canvas folder as the workspace
    let encoded: String = dir
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect();
    format!("http://127.0.0.1:{port}/?folder={encoded}")
}

// ---------- framing proxy ----------

const SECRET_COOKIE: &str = "vscode-cli-secret-half";

/// Read up to the end of an HTTP head. Returns (head, bytes read past it).
fn read_head(s: &mut TcpStream) -> Option<(String, Vec<u8>)> {
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    loop {
        let n = s.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let rest = buf.split_off(i + 4);
            return Some((String::from_utf8_lossy(&buf).into_owned(), rest));
        }
        if buf.len() > 64 * 1024 {
            return None;
        }
    }
}

fn header_name(line: &str) -> String {
    line.split(':').next().unwrap_or("").trim().to_ascii_lowercase()
}

/// Settings defaults for the embedded workbench, so it matches the dark canvas.
/// They're only defaults: a theme picked inside VS Code still wins.
const WORKBENCH_DEFAULTS: &str =
    "&quot;configurationDefaults&quot;:{&quot;workbench.colorTheme&quot;:&quot;Dark 2026&quot;},";

/// Splice the defaults into the page's (HTML-escaped JSON) workbench config.
fn with_defaults(html: &str) -> String {
    let marker = "id=\"vscode-workbench-web-configuration\" data-settings=\"{";
    match html.find(marker) {
        Some(i) => {
            let at = i + marker.len();
            format!("{}{}{}", &html[..at], WORKBENCH_DEFAULTS, &html[at..])
        }
        None => html.to_string(),
    }
}

fn proxy_conn(mut client: TcpStream, upstream: u16, secret: Arc<Mutex<Option<String>>>) {
    let Some((head, rest)) = read_head(&mut client) else { return };
    let mut lines = head.split("\r\n").filter(|l| !l.is_empty());
    let Some(request_line) = lines.next() else { return };
    let headers: Vec<&str> = lines.collect();
    let upgrade = headers.iter().any(|h| header_name(h) == "upgrade");

    // the workbench page gets rewritten, so ask for it unchunked (HTTP/1.0)
    let page = request_line.starts_with("GET / ") || request_line.starts_with("GET /?");
    let request_line = if page {
        request_line.replace("HTTP/1.1", "HTTP/1.0")
    } else {
        request_line.to_string()
    };
    let mut out = format!("{request_line}\r\n");
    let mut had_cookie = false;
    let stored = secret.lock().unwrap().clone();
    for h in &headers {
        match header_name(h).as_str() {
            // one request per connection keeps response rewriting trivial
            "connection" | "keep-alive" if !upgrade => {}
            "cookie" => {
                had_cookie = true;
                match &stored {
                    Some(c) if !h.contains(SECRET_COOKIE) => out.push_str(&format!("{h}; {c}\r\n")),
                    _ => out.push_str(&format!("{h}\r\n")),
                }
            }
            _ => out.push_str(&format!("{h}\r\n")),
        }
    }
    if let (false, Some(c)) = (had_cookie, &stored) {
        out.push_str(&format!("Cookie: {c}\r\n"));
    }
    if !upgrade {
        out.push_str("Connection: close\r\n");
    }
    out.push_str("\r\n");

    let Ok(mut up) = TcpStream::connect(("127.0.0.1", upstream)) else { return };
    if up.write_all(out.as_bytes()).is_err() || up.write_all(&rest).is_err() {
        return;
    }

    // request body / websocket frames: client -> upstream
    if let (Ok(mut c), Ok(mut u)) = (client.try_clone(), up.try_clone()) {
        std::thread::spawn(move || {
            let _ = std::io::copy(&mut c, &mut u);
            let _ = u.shutdown(Shutdown::Write);
        });
    }

    let Some((head, rest)) = read_head(&mut up) else {
        let _ = client.shutdown(Shutdown::Both);
        return;
    };
    let mut resp = String::new();
    for (i, line) in head.split("\r\n").filter(|l| !l.is_empty()).enumerate() {
        if i > 0 {
            let name = header_name(line);
            if name == "x-frame-options" {
                continue;
            }
            if name == "content-security-policy" && line.contains("frame-ancestors") {
                continue;
            }
            if page && (name == "content-length" || name == "transfer-encoding") {
                continue;
            }
            if name == "set-cookie" {
                let value = line.splitn(2, ':').nth(1).unwrap_or("").trim();
                if value.starts_with(SECRET_COOKIE) {
                    let pair = value.split(';').next().unwrap_or("").to_string();
                    *secret.lock().unwrap() = Some(pair);
                }
            }
        }
        resp.push_str(line);
        resp.push_str("\r\n");
    }
    if page {
        let mut body = rest;
        let _ = up.read_to_end(&mut body);
        let html = with_defaults(&String::from_utf8_lossy(&body));
        resp.push_str(&format!("Content-Length: {}\r\n\r\n", html.len()));
        let _ = client.write_all(resp.as_bytes());
        let _ = client.write_all(html.as_bytes());
        let _ = client.shutdown(Shutdown::Both);
        return;
    }
    resp.push_str("\r\n");
    if client.write_all(resp.as_bytes()).is_ok() && client.write_all(&rest).is_ok() {
        let _ = std::io::copy(&mut up, &mut client);
    }
    let _ = client.shutdown(Shutdown::Both);
}

fn start_proxy(upstream: u16, stop: Arc<AtomicBool>) -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let secret = Arc::new(Mutex::new(None));
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            if let Ok(c) = conn {
                let secret = secret.clone();
                std::thread::spawn(move || proxy_conn(c, upstream, secret));
            }
        }
    });
    Ok(port)
}

// ---------- commands ----------

/// Start (or reuse) a `code serve-web` server for `dir` and return its URL.
/// Blocks until the server accepts connections — the first ever run downloads
/// the web server bits, so the timeout is generous.
#[tauri::command]
pub fn code_serve(dir: String) -> Result<CodeServer, String> {
    if dir.is_empty() {
        return Err("This canvas has no folder yet — set one first.".into());
    }
    {
        let mut map = servers().lock().unwrap();
        if let Some(s) = map.get_mut(&dir) {
            match s.child.try_wait() {
                Ok(None) if listening(s.upstream) => {
                    return Ok(CodeServer {
                        url: url_for(s.proxy, &dir),
                        port: s.proxy,
                        started: false,
                    })
                }
                _ => {
                    s.kill();
                    map.remove(&dir);
                }
            }
        }
    }

    let code = code_binary().ok_or_else(|| {
        "Couldn't find the `code` command. In VS Code run \
         \"Shell Command: Install 'code' command in PATH\"."
            .to_string()
    })?;
    let upstream = free_port()?;
    let mut cmd = Command::new(&code);
    cmd.args([
        "serve-web",
        "--host",
        "127.0.0.1",
        "--port",
        &upstream.to_string(),
        "--without-connection-token",
        "--accept-server-license-terms",
    ])
    .current_dir(&dir)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("couldn't start `code serve-web`: {e}"))?;

    let deadline = Instant::now() + Duration::from_secs(90);
    while Instant::now() < deadline {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!(
                "`code serve-web` exited early ({status}). Run it in a terminal to see why."
            ));
        }
        if listening(upstream) {
            let stop = Arc::new(AtomicBool::new(false));
            let proxy = match start_proxy(upstream, stop.clone()) {
                Ok(p) => p,
                Err(e) => {
                    kill_tree(&mut child);
                    return Err(e);
                }
            };
            servers().lock().unwrap().insert(
                dir.clone(),
                Server { upstream, proxy, stop, child },
            );
            return Ok(CodeServer {
                url: url_for(proxy, &dir),
                port: proxy,
                started: true,
            });
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    kill_tree(&mut child);
    Err("`code serve-web` didn't start listening in time.".into())
}

/// Stop the server for one folder (if any).
#[tauri::command]
pub fn code_stop(dir: String) {
    if let Some(mut s) = servers().lock().unwrap().remove(&dir) {
        s.kill();
    }
}

/// Kill every server — called when the app exits so none are left orphaned.
pub fn stop_all() {
    if let Ok(mut map) = servers().lock() {
        for (_, s) in map.iter_mut() {
            s.kill();
        }
        map.clear();
    }
}
