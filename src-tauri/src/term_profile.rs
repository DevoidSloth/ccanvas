// The user's own terminal look, read from the machine rather than hardcoded.
//
// On macOS this reads the default iTerm2 profile (font, size, cursor, ANSI
// palette) from its preferences plist. Any field that can't be found is left
// out, and the frontend fills the gaps with ccanvas's built-in theme; when
// there's no iTerm2 at all the command returns `None` and the built-in theme is
// used as-is.

use std::collections::HashMap;
use std::path::PathBuf;

use plist::{Dictionary, Value};
use serde::Serialize;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TermProfile {
    source: String,
    /// PostScript name (WebKit matches these in CSS `font-family` on macOS)
    font_family: Option<String>,
    font_size: Option<f64>,
    line_height: Option<f64>,
    cursor_style: Option<String>,
    cursor_blink: Option<bool>,
    bold_is_bright: Option<bool>,
    /// xterm.js theme keys → `#rrggbb`
    theme: HashMap<String, String>,
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// `{"Red Component": 0.1, …}` → `#rrggbb`
fn color(dict: &Dictionary) -> Option<String> {
    let c = |k: &str| dict.get(k).and_then(Value::as_real);
    let (r, g, b) = (c("Red Component")?, c("Green Component")?, c("Blue Component")?);
    let px = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    Some(format!("#{:02x}{:02x}{:02x}", px(r), px(g), px(b)))
}

fn iterm_profile() -> Option<TermProfile> {
    let path = home()?.join("Library/Preferences/com.googlecode.iterm2.plist");
    let root = Value::from_file(path).ok()?.into_dictionary()?;
    let profiles = root.get("New Bookmarks")?.as_array()?;
    let default_guid = root.get("Default Bookmark Guid").and_then(Value::as_string);
    let profile = profiles
        .iter()
        .filter_map(Value::as_dictionary)
        .find(|p| p.get("Guid").and_then(Value::as_string) == default_guid)
        .or_else(|| profiles.first().and_then(Value::as_dictionary))?;

    let mut out = TermProfile {
        source: "iTerm2".into(),
        ..Default::default()
    };

    // "MesloLGLDZForPowerline-Regular 12" → name + size
    if let Some(font) = profile.get("Normal Font").and_then(Value::as_string) {
        match font.rsplit_once(' ') {
            Some((name, size)) if size.parse::<f64>().is_ok() => {
                out.font_family = Some(name.to_string());
                out.font_size = size.parse().ok();
            }
            _ => out.font_family = Some(font.to_string()),
        }
    }
    out.line_height = profile.get("Vertical Spacing").and_then(Value::as_real);
    // iTerm2: 0 underline, 1 vertical bar, 2 box (the default when unset)
    out.cursor_style = Some(
        match profile.get("Cursor Type").and_then(Value::as_signed_integer) {
            Some(0) => "underline",
            Some(1) => "bar",
            _ => "block",
        }
        .into(),
    );
    out.cursor_blink = profile.get("Blinking Cursor").and_then(Value::as_boolean);
    out.bold_is_bright = profile.get("Use Bright Bold").and_then(Value::as_boolean);

    // profiles with separate light/dark palettes store "<key> (Dark)"; ccanvas
    // is always dark, so prefer those
    let split = profile
        .get("Use Separate Colors for Light and Dark Mode")
        .and_then(Value::as_boolean)
        .unwrap_or(false);
    let lookup = |key: &str| {
        let dark = format!("{key} (Dark)");
        let v = if split { profile.get(&dark).or_else(|| profile.get(key)) } else { profile.get(key) };
        v.and_then(Value::as_dictionary).and_then(color)
    };

    const ANSI: [&str; 16] = [
        "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
        "brightBlack", "brightRed", "brightGreen", "brightYellow",
        "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
    ];
    let named = [
        ("background", "Background Color"),
        ("foreground", "Foreground Color"),
        ("cursor", "Cursor Color"),
        ("cursorAccent", "Cursor Text Color"),
        ("selectionBackground", "Selection Color"),
        ("selectionForeground", "Selected Text Color"),
    ];
    for (i, name) in ANSI.iter().enumerate() {
        if let Some(c) = lookup(&format!("Ansi {i} Color")) {
            out.theme.insert((*name).into(), c);
        }
    }
    for (name, key) in named {
        if let Some(c) = lookup(key) {
            out.theme.insert(name.into(), c);
        }
    }
    Some(out)
}

#[tauri::command]
pub fn terminal_profile() -> Option<TermProfile> {
    if cfg!(target_os = "macos") {
        iterm_profile()
    } else {
        None
    }
}

/// The user's locale as a POSIX `LANG` (e.g. `en_US.UTF-8`), for shells spawned
/// from a GUI app, which never inherit one. macOS keeps it in global prefs.
pub fn system_lang() -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let path = home()?.join("Library/Preferences/.GlobalPreferences.plist");
    let root = Value::from_file(path).ok()?.into_dictionary()?;
    // "en_US" or "en_US@rg=…"; drop any modifiers
    let locale = root.get("AppleLocale")?.as_string()?.split('@').next()?.to_string();
    (!locale.is_empty()).then(|| format!("{locale}.UTF-8"))
}
