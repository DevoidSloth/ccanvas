// Icons for zoomed-out cards, layer tiles and title bars: a web page's own
// site icon, and the icon of an app installed on this Mac (Spotify, Music,
// VS Code, Claude).
//
// Site icons come from the site itself, never a third-party icon service (that
// would tell someone else every host the widget visits): the page's
// `<link rel=icon>` (the biggest it offers, an Apple touch icon first, as those
// stay sharp on a large card), else `/favicon.ico`. Fetched through the preview
// proxy's client, so the same rules hold: public http(s) only, never this
// machine or the local network, on every redirect.
//
// Both are returned as data: URLs and cached per host / app, in memory and on
// disk (the app's cache folder), so a card never fetches twice. A site with no
// icon is remembered too, for a day.

use base64::Engine;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Manager, Url};

/// A page read for its `<link>` tags: only its head matters.
const MAX_PAGE: usize = 512 * 1024;
/// An icon bigger than this isn't an icon.
const MAX_ICON: usize = 384 * 1024;
/// How long "this site has no icon" is believed.
const MISS_TTL: Duration = Duration::from_secs(24 * 3600);

fn memory() -> &'static Mutex<HashMap<String, Option<String>>> {
    static M: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A cache key safe as a file name.
fn file_key(prefix: &str, key: &str) -> String {
    let safe: String = key
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("{prefix}-{safe}")
}

fn cache_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_cache_dir().ok()?.join("icons");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// The cached answer: Some(Some(icon)), Some(None) for a recent miss, None if
/// not known yet.
fn cached(app: &AppHandle, key: &str) -> Option<Option<String>> {
    if let Some(v) = memory().lock().ok()?.get(key) {
        return Some(v.clone());
    }
    let path = cache_dir(app)?.join(key);
    let meta = std::fs::metadata(&path).ok()?;
    let text = std::fs::read_to_string(&path).ok()?;
    let v = if text.starts_with("data:") {
        Some(text)
    } else {
        // a miss: only for a while
        let age = meta
            .modified()
            .ok()
            .and_then(|m| SystemTime::now().duration_since(m).ok());
        if age.map_or(true, |a| a > MISS_TTL) {
            return None;
        }
        None
    };
    memory().lock().ok()?.insert(key.to_string(), v.clone());
    Some(v)
}

fn remember(app: &AppHandle, key: &str, v: &Option<String>) {
    if let Ok(mut m) = memory().lock() {
        m.insert(key.to_string(), v.clone());
    }
    if let Some(dir) = cache_dir(app) {
        let _ = std::fs::write(dir.join(key), v.as_deref().unwrap_or(""));
    }
}

fn data_url(mime: &str, bytes: &[u8]) -> String {
    format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

// ---------- site icons ----------

/// The site icon for the page at `url` (a data: URL), or None (a local page,
/// no icon, offline).
#[tauri::command]
pub async fn site_icon(app: AppHandle, url: String) -> Option<String> {
    let page = Url::parse(&url).ok()?;
    if !crate::web_proxy::fetchable(&page) {
        return None;
    }
    let host = page
        .host_str()?
        .trim_start_matches("www.")
        .to_ascii_lowercase();
    let key = file_key("site", &host);
    if let Some(v) = cached(&app, &key) {
        return v;
    }
    // the site's front page, never the page itself: icons are per host, and
    // a second GET of the page could spend a one-time link (a sign-in link,
    // an OAuth callback) before the browser view does
    let mut home = page.join("/").ok()?;
    home.set_query(None);
    home.set_fragment(None);
    let (found, reached) = find_site_icon(&home).await;
    // a site that couldn't be reached (offline, a timeout) is asked again next time
    if found.is_some() || reached {
        remember(&app, &key, &found);
    }
    found
}

/// The icon, and whether the site answered at all.
async fn find_site_icon(page: &Url) -> (Option<String>, bool) {
    let mut reached = false;
    // the page's own links, best first; then the conventional spot
    let mut candidates = match fetch(page, MAX_PAGE).await {
        Ok(Some((final_url, ctype, body))) if ctype.contains("html") => {
            reached = true;
            icon_links(&String::from_utf8_lossy(&body), &final_url)
        }
        Ok(_) => {
            reached = true;
            Vec::new()
        }
        Err(()) => Vec::new(),
    };
    if let Ok(ico) = page.join("/favicon.ico") {
        candidates.push(ico);
    }
    for c in candidates.into_iter().take(5) {
        if c.scheme() == "data" {
            if c.as_str().starts_with("data:image/") && c.as_str().len() < MAX_ICON {
                return (Some(c.to_string()), true);
            }
            continue;
        }
        if !crate::web_proxy::fetchable(&c) {
            continue;
        }
        match fetch(&c, MAX_ICON).await {
            Ok(Some((_, ctype, body))) => {
                reached = true;
                if let Some(mime) = image_mime(&ctype, &body) {
                    return (Some(data_url(mime, &body)), true);
                }
            }
            Ok(None) => reached = true,
            Err(()) => {}
        }
    }
    (None, reached)
}

/// The response: Ok(None) when the site answered with nothing usable (an
/// error status, too big), Err when it couldn't be reached at all.
async fn fetch(url: &Url, max: usize) -> Result<Option<(Url, String, Vec<u8>)>, ()> {
    let Ok(mut resp) = crate::web_proxy::client()
        .get(url.clone())
        .header(
            "user-agent",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
        )
        .timeout(Duration::from_secs(8))
        .send()
        .await
    else {
        return Err(());
    };
    if !resp.status().is_success() {
        return Ok(None);
    }
    let final_url = resp.url().clone();
    let ctype = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|_| ())? {
        body.extend_from_slice(&chunk);
        if body.len() > max {
            // a page's head is in its first bytes; an icon this big isn't one
            if ctype.contains("html") {
                break;
            }
            return Ok(None);
        }
    }
    Ok(Some((final_url, ctype, body)))
}

/// What an icon's bytes are, from their first bytes (servers often send
/// icons as text/plain or octet-stream), or the content type for SVG.
fn image_mime(ctype: &str, b: &[u8]) -> Option<&'static str> {
    if b.len() < 4 {
        return None;
    }
    if b.starts_with(b"\x89PNG") {
        return Some("image/png");
    }
    if b.starts_with(&[0, 0, 1, 0]) {
        return Some("image/x-icon");
    }
    if b.starts_with(b"GIF8") {
        return Some("image/gif");
    }
    if b.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if b.len() > 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    let head = String::from_utf8_lossy(&b[..b.len().min(512)]).to_ascii_lowercase();
    if ctype.contains("svg") || (head.contains("<svg") && !head.contains("<html")) {
        return Some("image/svg+xml");
    }
    None
}

/// The icon links in a page's HTML, best first: Apple touch icons (large),
/// then icons by declared size (an SVG counts as large), each resolved
/// against the page.
fn icon_links(html: &str, base: &Url) -> Vec<Url> {
    // the <base> of the page wins over its address
    let lower = html.to_ascii_lowercase();
    // (the body is already bounded; slicing at a fixed length could split a character)
    let end = lower.find("</head>").unwrap_or(lower.len());
    let head = &html[..end];
    let head_lower = &lower[..end];
    let mut found: Vec<(u32, Url)> = Vec::new();
    let mut at = 0;
    while let Some(i) = head_lower[at..].find("<link") {
        let start = at + i;
        let Some(close) = head_lower[start..].find('>') else {
            break;
        };
        let tag = &head[start..start + close];
        at = start + close;
        let rel = attr(tag, "rel").unwrap_or_default().to_ascii_lowercase();
        if !rel
            .split_ascii_whitespace()
            .any(|r| r == "icon" || r == "apple-touch-icon" || r == "apple-touch-icon-precomposed")
        {
            continue;
        }
        let Some(href) = attr(tag, "href") else {
            continue;
        };
        let Ok(url) = base.join(href.trim()) else {
            continue;
        };
        let typ = attr(tag, "type").unwrap_or_default().to_ascii_lowercase();
        let size = attr(tag, "sizes")
            .unwrap_or_default()
            .split_ascii_whitespace()
            .filter_map(|s| s.split(['x', 'X']).next()?.parse::<u32>().ok())
            .max()
            .unwrap_or(0);
        let score = if rel.contains("apple-touch-icon") {
            1000 + size.max(180)
        } else if typ.contains("svg") || href.to_ascii_lowercase().ends_with(".svg") {
            900
        } else {
            size.max(16)
        };
        found.push((score, url));
    }
    found.sort_by_key(|f| std::cmp::Reverse(f.0));
    found.into_iter().map(|(_, u)| u).collect()
}

/// An attribute's value in one tag (quoted or bare).
fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = lower[from..].find(name) {
        let at = from + i;
        from = at + name.len();
        // a whole attribute name, followed by =
        let before_ok = at == 0 || lower.as_bytes()[at - 1].is_ascii_whitespace();
        let rest = lower[from..].trim_start();
        if !before_ok || !rest.starts_with('=') {
            continue;
        }
        let vstart = from + (lower[from..].len() - rest.len()) + 1;
        let v = tag[vstart..].trim_start();
        let off = tag.len() - v.len();
        return Some(match v.chars().next()? {
            q @ ('"' | '\'') => {
                let body = &tag[off + 1..];
                &body[..body.find(q).unwrap_or(body.len())]
            }
            _ => {
                let end = v
                    .find(|c: char| c.is_ascii_whitespace() || c == '>')
                    .unwrap_or(v.len());
                &tag[off..off + end]
            }
        });
    }
    None
}

// ---------- app icons ----------

/// The icon of the installed app with this bundle id (a PNG data: URL), or
/// None if it isn't installed (or this isn't a Mac).
#[tauri::command]
pub async fn app_icon(app: AppHandle, bundle_id: String) -> Option<String> {
    if bundle_id.is_empty()
        || bundle_id.len() > 128
        || !bundle_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
    {
        return None;
    }
    let key = file_key("app", &bundle_id);
    if let Some(v) = cached(&app, &key) {
        return v;
    }
    let dir = cache_dir(&app)?;
    let found = tauri::async_runtime::spawn_blocking(move || app_icon_png(&bundle_id, &dir))
        .await
        .ok()
        .flatten();
    remember(&app, &key, &found);
    found
}

#[cfg(target_os = "macos")]
fn app_icon_png(bundle_id: &str, dir: &std::path::Path) -> Option<String> {
    use std::process::Command;
    // where the app is: Spotlight knows every installed bundle
    let out = Command::new("/usr/bin/mdfind")
        .arg(format!("kMDItemCFBundleIdentifier == '{bundle_id}'"))
        .output()
        .ok()?;
    let found = String::from_utf8_lossy(&out.stdout);
    let app = found.lines().map(PathBuf::from).find(|p| {
        p.extension().is_some_and(|e| e == "app") && p.join("Contents/Info.plist").exists()
    })?;
    let info = plist::Value::from_file(app.join("Contents/Info.plist")).ok()?;
    let name = info
        .as_dictionary()?
        .get("CFBundleIconFile")?
        .as_string()?
        .to_string();
    let file = if name.ends_with(".icns") {
        name
    } else {
        format!("{name}.icns")
    };
    let icns = app.join("Contents/Resources").join(file);
    if !icns.exists() {
        return None;
    }
    // sips (part of macOS) turns the icon set into one 128 px PNG
    let png = dir.join(format!("{}.png", file_key("app", bundle_id)));
    let ok = Command::new("/usr/bin/sips")
        .args(["-s", "format", "png", "--resampleHeightWidthMax", "128"])
        .arg(&icns)
        .arg("--out")
        .arg(&png)
        .output()
        .ok()?
        .status
        .success();
    if !ok {
        return None;
    }
    let bytes = std::fs::read(&png).ok()?;
    let _ = std::fs::remove_file(&png);
    Some(data_url("image/png", &bytes))
}

#[cfg(not(target_os = "macos"))]
fn app_icon_png(_bundle_id: &str, _dir: &std::path::Path) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_icon_links_best_first() {
        let base = Url::parse("https://example.com/a/page").unwrap();
        let html = r#"<html><head>
            <link rel="icon" href="/favicon-16.png" sizes="16x16">
            <link rel='icon' type='image/png' href='icons/32.png' sizes='32x32'>
            <link rel="stylesheet" href="/x.css">
            <LINK REL="apple-touch-icon" HREF="/touch.png">
            </head><body><link rel="icon" href="/late.png"></body></html>"#;
        let got: Vec<String> = icon_links(html, &base)
            .into_iter()
            .map(String::from)
            .collect();
        assert_eq!(
            got,
            vec![
                "https://example.com/touch.png",
                "https://example.com/a/icons/32.png",
                "https://example.com/favicon-16.png",
            ]
        );
    }

    #[test]
    fn reads_attributes() {
        assert_eq!(
            attr(r#"<link rel="icon" href="/a.png""#, "href"),
            Some("/a.png")
        );
        assert_eq!(attr("<link rel=icon href=/b.ico", "href"), Some("/b.ico"));
        assert_eq!(
            attr(r#"<link data-href="x" href='/c.svg'"#, "href"),
            Some("/c.svg")
        );
        assert_eq!(attr("<link rel=icon", "href"), None);
    }

    #[test]
    fn sniffs_images() {
        assert_eq!(image_mime("text/plain", b"\x89PNG\r\n"), Some("image/png"));
        assert_eq!(image_mime("", &[0, 0, 1, 0, 1, 0]), Some("image/x-icon"));
        assert_eq!(
            image_mime("image/svg+xml", b"<svg xmlns"),
            Some("image/svg+xml")
        );
        assert_eq!(image_mime("text/html", b"<html><body>404</body>"), None);
    }

    #[test]
    fn cache_keys_are_file_names() {
        assert_eq!(
            file_key("site", "a.example.com:8080"),
            "site-a.example.com_8080"
        );
        assert_eq!(file_key("app", "../x"), "app-.._x");
    }
}
