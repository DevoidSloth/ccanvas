// The web widget's canvas preview of remote sites, served in-process so the
// desktop app doesn't need the Node server (`npm run server`) for it.
//
// Most sites refuse to be framed (X-Frame-Options / CSP frame-ancestors), so on
// the canvas a remote page loads through here instead: `GET /proxy?url=` fetches
// the page server-side and sends it back with only a content type, so none of
// its framing, cookie or CSP headers come along. A `<base>` makes its relative
// URLs resolve upstream, and a small script keeps in-page links inside the
// preview (and tells the widget where it went). It's a preview: no cookies, no
// logins. The full browser is the native view in focus mode (native_view.rs).
// Videos don't go through the page proxy: `GET /player?src=` frames the
// site's own player (see "video players" below).
//
// Safety:
//   • It listens on its own random loopback port, so a proxied page runs on an
//     origin that is neither the app's nor any API's.
//   • Only http(s) targets, and never this machine or the local network (by IP
//     literal, by DNS answer, and on every redirect): a proxied page is
//     same-origin with this proxy and can read what it returns, so it must not
//     reach loopback servers (the media server, dev servers, the Node API).
//     Local dev servers don't need it anyway: the widget frames them directly.
//   • The Host header must be our own address (stops DNS rebinding).
//
// Hand-rolled on std::net like media.rs and editor.rs; the fetch itself uses
// reqwest, which the updater already brings in.

use crate::editor::{header_name, read_head};
use std::io::Write;
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::Url;

static PORT: OnceLock<u16> = OnceLock::new();

/// Biggest response passed through (a page, an image): previews, not downloads.
const MAX_BODY: usize = 32 * 1024 * 1024;

/// Start the proxy once, on a background thread. Non-fatal on failure (the
/// widget then frames sites directly, which most refuse).
pub fn start() {
    if PORT.get().is_some() {
        return;
    }
    let Ok(listener) = TcpListener::bind("127.0.0.1:0") else {
        return;
    };
    let Ok(port) = listener.local_addr().map(|a| a.port()) else {
        return;
    };
    let _ = PORT.set(port);
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            std::thread::spawn(move || handle(stream, port));
        }
    });
}

/// Base URL of the proxy, e.g. http://127.0.0.1:52341 (None if it didn't start).
#[tauri::command]
pub fn web_proxy_url() -> Option<String> {
    PORT.get().map(|p| format!("http://127.0.0.1:{p}"))
}

// ---------- what may be fetched ----------

/// Addresses on this machine or the local network.
fn private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || (a == 100 && (64..128).contains(&b)) // carrier-grade NAT
                || a == 0
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return private_ip(IpAddr::V4(v4));
            }
            let seg0 = v6.segments()[0];
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (seg0 & 0xfe00) == 0xfc00 // unique local
                || (seg0 & 0xffc0) == 0xfe80 // link-local
        }
    }
}

/// An http(s) URL whose host isn't, on its face, local. (Names are checked
/// again when they resolve.)
pub(crate) fn fetchable(url: &Url) -> bool {
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    if let Ok(ip) = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
    {
        return !private_ip(ip);
    }
    let d = host.trim_end_matches('.').to_ascii_lowercase();
    !(d == "localhost" || d.ends_with(".localhost"))
}

/// DNS that refuses to hand back local addresses, so a public name pointed at
/// 127.0.0.1 can't be used to reach this machine.
struct PublicOnly;

impl reqwest::dns::Resolve for PublicOnly {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let addrs: Vec<SocketAddr> =
                tauri::async_runtime::spawn_blocking(move || (host.as_str(), 0).to_socket_addrs())
                    .await
                    .map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)??
                    .filter(|a| !private_ip(a.ip()))
                    .collect();
            if addrs.is_empty() {
                return Err("refusing a local address".into());
            }
            Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

pub(crate) fn client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        // rustls needs a crypto provider chosen once per process (the updater
        // does the same; whichever runs first wins)
        let _ = rustls::crypto::ring::default_provider().install_default();
        reqwest::Client::builder()
            // never through an HTTP(S)_PROXY from the environment: a proxy
            // resolves names itself, which would get round PublicOnly
            .no_proxy()
            .dns_resolver(PublicOnly)
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() > 10 {
                    attempt.error("too many redirects")
                } else if !fetchable(attempt.url()) {
                    attempt.error("refusing a local address")
                } else {
                    attempt.follow()
                }
            }))
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .expect("http client")
    })
}

// ---------- serving ----------

fn send(s: &mut TcpStream, status: u16, reason: &str, ctype: &str, extra: &str, body: &[u8]) {
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n{extra}\
         Connection: close\r\n\r\n",
        body.len()
    );
    let _ = s.write_all(head.as_bytes());
    let _ = s.write_all(body);
}

fn respond(s: &mut TcpStream, status: u16, reason: &str, ctype: &str, body: &[u8]) {
    send(
        s,
        status,
        reason,
        ctype,
        "Referrer-Policy: no-referrer\r\n",
        body,
    );
}

fn fail(s: &mut TcpStream, status: u16, reason: &str, msg: &str) {
    respond(
        s,
        status,
        reason,
        "text/plain; charset=utf-8",
        msg.as_bytes(),
    );
}

fn handle(mut s: TcpStream, port: u16) {
    let _ = s.set_read_timeout(Some(Duration::from_secs(10)));
    let Some((head, _)) = read_head(&mut s) else {
        return;
    };
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let mut host = "";
    let mut agent = "ccanvas";
    for line in lines {
        let value = line.split_once(':').map_or("", |(_, v)| v.trim());
        match header_name(line).as_str() {
            "host" => host = value,
            "user-agent" => agent = value,
            _ => {}
        }
    }
    if host != format!("127.0.0.1:{port}") && host != format!("localhost:{port}") {
        return fail(&mut s, 403, "Forbidden", "bad host");
    }
    let mut parts = request_line.split(' ');
    let (method, path) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let route = path.split('?').next().unwrap_or("");
    if method != "GET" || !matches!(route, "/proxy" | "/player") {
        return fail(&mut s, 404, "Not Found", "not found");
    }
    if route == "/player" {
        return match query_url(path, "src").filter(player_src) {
            Some(src) => send(
                &mut s,
                200,
                "OK",
                "text/html; charset=utf-8",
                PLAYER_HEADERS,
                player_page(&src).as_bytes(),
            ),
            None => fail(&mut s, 400, "Bad Request", "not a video player"),
        };
    }
    let Some(target) = query_url(path, "url").filter(fetchable) else {
        return fail(
            &mut s,
            400,
            "Bad Request",
            "need a public http(s) url (local pages load directly)",
        );
    };

    let agent = agent.to_string();
    let fetched = tauri::async_runtime::block_on(async move {
        let mut resp = client()
            .get(target)
            .header("user-agent", agent)
            .send()
            .await?;
        let status = resp.status();
        let final_url = resp.url().clone();
        let ctype = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("text/html; charset=utf-8")
            .to_string();
        let mut body = Vec::new();
        while let Some(chunk) = resp.chunk().await? {
            body.extend_from_slice(&chunk);
            if body.len() > MAX_BODY {
                break;
            }
        }
        Ok::<_, reqwest::Error>((status, final_url, ctype, body))
    });
    match fetched {
        Ok((status, final_url, ctype, body)) => {
            let reason = status.canonical_reason().unwrap_or("");
            if ctype.contains("text/html") {
                let html = rewrite_html(&String::from_utf8_lossy(&body), &final_url);
                respond(&mut s, status.as_u16(), reason, &ctype, html.as_bytes());
            } else {
                respond(&mut s, status.as_u16(), reason, &ctype, &body);
            }
        }
        Err(e) => fail(&mut s, 502, "Bad Gateway", &e.to_string()),
    }
}

/// The URL in query parameter `key` of a request path.
fn query_url(path: &str, key: &str) -> Option<Url> {
    Url::parse(&format!("http://proxy{path}"))
        .ok()?
        .query_pairs()
        .find(|(k, _)| k == key)
        .and_then(|(_, v)| Url::parse(&v).ok())
}

// ---------- video players ----------
//
// Video sites ship a player made to be framed (youtube.com/embed/…), which is
// how a video plays on the canvas: a full site like youtube.com is a JS app
// the preview can't run. But YouTube's player refuses to play without a
// Referer ("Error 153"), and WebKit sends none from the app's own tauri://
// page. So `GET /player?src=` serves a page from this loopback origin that
// frames the player and sends only that origin as the referrer. It frames
// nothing but the known players.

const PLAYER_HEADERS: &str = "Referrer-Policy: strict-origin-when-cross-origin\r\n\
    Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; \
    frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com\r\n";

/// A framable video player: YouTube's /embed/ or Vimeo's /video/, over https.
pub(crate) fn player_src(url: &Url) -> bool {
    url.scheme() == "https"
        && url.port().is_none()
        && match url.host_str() {
            Some("www.youtube.com" | "www.youtube-nocookie.com") => {
                url.path().starts_with("/embed/")
            }
            Some("player.vimeo.com") => url.path().starts_with("/video/"),
            _ => false,
        }
}

fn player_page(src: &Url) -> String {
    format!(
        "<!doctype html><meta charset=\"utf-8\"><title>player</title>\
         <style>html,body{{margin:0;height:100%;background:#000;overflow:hidden}}\
         iframe{{display:block;border:0;width:100%;height:100%}}</style>\
         <iframe src=\"{}\" allow=\"autoplay; encrypted-media; fullscreen; picture-in-picture\" \
         allowfullscreen></iframe>",
        attr_escape(src.as_str())
    )
}

// ---------- page rewriting ----------

/// Keep in-page links inside the preview, and tell the widget (the parent
/// frame) which page is showing so its address bar and history follow.
/// Plain left-clicks on same-tab http(s) links only, after the page's own
/// handlers (a client-side router that handled the click is left alone).
const NAV_SCRIPT: &str = r#"(function(){
var here=__URL__,via=location.origin+'/proxy?url=';
try{parent.postMessage({type:'ccanvas-web-nav',url:here},'*')}catch(e){}
addEventListener('click',function(e){
if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
var a=e.target&&e.target.closest&&e.target.closest('a[href]');
if(!a||(a.target&&a.target!=='_self')||a.hasAttribute('download'))return;
var u;try{u=new URL(a.getAttribute('href'),document.baseURI)}catch(_){return}
if(u.protocol!=='http:'&&u.protocol!=='https:')return;
if(u.hash&&u.href.split('#')[0]===here.split('#')[0])return;
e.preventDefault();location.href=via+encodeURIComponent(u.href);
});
})();"#;

fn attr_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Find `<head …>` case-insensitively; returns the index just past it.
fn after_head_tag(html: &str) -> Option<usize> {
    let lower = html.to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = lower[from..].find("<head") {
        let at = from + i;
        // `<header>` isn't `<head>`
        match lower.as_bytes().get(at + 5) {
            Some(b'>') | Some(b' ') | Some(b'\t') | Some(b'\n') | Some(b'\r') => {
                return lower[at..].find('>').map(|j| at + j + 1);
            }
            _ => from = at + 5,
        }
    }
    None
}

pub(crate) fn rewrite_html(html: &str, url: &Url) -> String {
    let page = url.as_str();
    let mut inject = String::new();
    if !html.to_ascii_lowercase().contains("<base ") {
        inject.push_str(&format!("<base href=\"{}\">", attr_escape(page)));
    }
    // a JSON string literal; `<` escaped so it can't close the script early
    let quoted = serde_json::to_string(page)
        .unwrap_or_else(|_| "\"\"".into())
        .replace('<', "\\u003c");
    inject.push_str("<script>");
    inject.push_str(&NAV_SCRIPT.replace("__URL__", &quoted));
    inject.push_str("</script>");
    match after_head_tag(html) {
        Some(at) => format!("{}{}{}", &html[..at], inject, &html[at..]),
        None => format!("{inject}{html}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn refuses_local_targets() {
        for bad in [
            "http://127.0.0.1:7531/health",
            "http://localhost:5173/",
            "http://app.localhost/",
            "http://[::1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://10.0.0.8/",
            "http://192.168.1.1/",
            "http://169.254.169.254/latest/meta-data/",
            "http://0.0.0.0/",
            "file:///etc/hosts",
            "tauri://localhost/",
        ] {
            assert!(!fetchable(&u(bad)), "{bad} should be refused");
        }
        for ok in [
            "https://example.com/",
            "http://93.184.216.34/",
            "https://[2606:4700::1111]/",
        ] {
            assert!(fetchable(&u(ok)), "{ok} should be allowed");
        }
    }

    #[test]
    fn injects_base_and_script_after_head() {
        let out = rewrite_html(
            "<html><header>x</header><HEAD lang=en><title>t</title></HEAD></html>",
            &u("https://example.com/a?b=\"c\""),
        );
        let at = out.find("<HEAD lang=en>").unwrap() + "<HEAD lang=en>".len();
        assert!(out[at..].starts_with("<base href=\"https://example.com/a?b=%22c%22\">"));
        assert!(out.contains("var here=\"https://example.com/a?b=%22c%22\""));
    }

    #[test]
    fn player_frames_only_video_players() {
        for ok in [
            "https://www.youtube.com/embed/dQw4w9WgXcQ?start=42",
            "https://www.youtube.com/embed/videoseries?list=PLabcdefghij",
            "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
            "https://player.vimeo.com/video/76979871",
        ] {
            assert!(player_src(&u(ok)), "{ok} should be allowed");
        }
        for bad in [
            "http://www.youtube.com/embed/dQw4w9WgXcQ",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://www.youtube.com:8443/embed/dQw4w9WgXcQ",
            "https://youtube.com.evil.test/embed/x",
            "https://evil.test/embed/x",
            "https://player.vimeo.com/api/x",
            "http://127.0.0.1:7531/embed/x",
            "javascript:alert(1)",
        ] {
            assert!(!player_src(&u(bad)), "{bad} should be refused");
        }
        let page = player_page(&u("https://www.youtube.com/embed/x?a=1&b=\"><script>"));
        assert!(
            page.contains("src=\"https://www.youtube.com/embed/x?a=1&amp;b=%22%3E%3Cscript%3E\"")
        );
        assert!(!page.contains("<script"));
    }

    #[test]
    fn query_urls() {
        assert_eq!(
            query_url("/player?src=https%3A%2F%2Fa.test%2Fx%3Fy%3D1", "src").map(String::from),
            Some("https://a.test/x?y=1".to_string())
        );
        assert!(query_url("/player?url=https%3A%2F%2Fa.test%2F", "src").is_none());
        assert!(query_url("/player?src=not%20a%20url", "src").is_none());
    }

    #[test]
    fn keeps_an_existing_base() {
        let out = rewrite_html(
            "<head><base href=\"/x/\"></head>",
            &u("https://example.com/"),
        );
        assert_eq!(out.matches("<base ").count(), 1);
    }
}
