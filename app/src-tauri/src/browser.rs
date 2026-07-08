use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, Webview, WebviewBuilder,
    WebviewUrl,
};
use tokio::sync::oneshot;
use tokio::time::timeout;
use url::Url;

const MAX_CAPTURE_TEXT_CHARS: usize = 12_000;
const CAPTURE_TIMEOUT_SECONDS: u64 = 5;

#[derive(Debug, Deserialize)]
pub struct BrowserBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Deserialize)]
pub struct BrowserOpenRequest {
    pub label: String,
    pub url: String,
    pub bounds: BrowserBounds,
}

#[derive(Debug, Deserialize)]
pub struct BrowserLabelRequest {
    pub label: String,
}

#[derive(Debug, Deserialize)]
pub struct BrowserNavigateRequest {
    pub label: String,
    pub url: String,
}

#[derive(Debug, Deserialize)]
pub struct BrowserResizeRequest {
    pub label: String,
    pub bounds: BrowserBounds,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserStateEvent {
    label: String,
    url: String,
    phase: String,
    title: Option<String>,
    can_go_back: bool,
    can_go_forward: bool,
    download_path: Option<String>,
    download_success: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BrowserCaptureResponse {
    pub url: String,
    pub title: Option<String>,
    pub text: String,
    pub selected_text: Option<String>,
    pub truncated: bool,
    pub captured_at: String,
}

#[derive(Debug, Default)]
struct BrowserNavigationState {
    entries: Vec<String>,
    index: Option<usize>,
}

static BROWSER_NAVIGATION: OnceLock<Mutex<HashMap<String, BrowserNavigationState>>> =
    OnceLock::new();

#[tauri::command]
fn open<R: Runtime>(app: AppHandle<R>, request: BrowserOpenRequest) -> Result<(), String> {
    let url = parse_browser_url(&request.url)?;
    validate_browser_label(&request.label)?;

    if let Some(webview) = app.get_webview(&request.label) {
        resize_webview(&webview, &request.bounds)?;
        webview.show().map_err(|err| err.to_string())?;
        webview.navigate(url).map_err(|err| err.to_string())?;
        return Ok(());
    }

    let window = app
        .get_window("main")
        .ok_or_else(|| "Main window is not available".to_string())?;
    let data_dir = browser_data_dir(&app)?;
    let label = request.label.clone();
    let app_for_events = app.clone();
    let label_for_title = request.label.clone();
    let app_for_title = app.clone();
    let label_for_new_window = request.label.clone();
    let app_for_new_window = app.clone();
    let label_for_download = request.label.clone();
    let app_for_download = app.clone();
    let webview_builder = WebviewBuilder::new(&request.label, WebviewUrl::External(url))
        .data_directory(data_dir)
        .enable_clipboard_access()
        .on_new_window(move |url, _features| {
            emit_browser_state(
                &app_for_new_window,
                browser_state_event(label_for_new_window.clone(), url.to_string(), "new-window"),
            );
            NewWindowResponse::Deny
        })
        .on_document_title_changed(move |webview, title| {
            let url = webview
                .url()
                .map(|url| url.to_string())
                .unwrap_or_else(|_| String::new());
            emit_browser_state(
                &app_for_title,
                browser_state_event(label_for_title.clone(), url, "title-changed")
                    .with_title(title),
            );
        })
        .on_download(move |_webview, event| {
            match event {
                DownloadEvent::Requested { url, destination } => {
                    emit_browser_state(
                        &app_for_download,
                        browser_state_event(
                            label_for_download.clone(),
                            url.to_string(),
                            "download-requested",
                        )
                        .with_download_path(destination),
                    );
                }
                DownloadEvent::Finished { url, path, success } => {
                    let mut event = browser_state_event(
                        label_for_download.clone(),
                        url.to_string(),
                        "download-finished",
                    )
                    .with_download_success(success);
                    if let Some(path) = path {
                        event = event.with_download_path(&path);
                    }
                    emit_browser_state(&app_for_download, event);
                }
                _ => {}
            }
            true
        })
        .on_page_load(move |_webview, payload| {
            let phase = match payload.event() {
                PageLoadEvent::Started => "started",
                PageLoadEvent::Finished => "finished",
            };
            let flags = if matches!(payload.event(), PageLoadEvent::Finished) {
                record_browser_url(&label, payload.url().as_str())
            } else {
                browser_navigation_flags(&label)
            };
            emit_browser_state(
                &app_for_events,
                browser_state_event(label.clone(), payload.url().to_string(), phase)
                    .with_navigation_flags(flags),
            );
        });

    window
        .add_child(
            webview_builder,
            LogicalPosition::new(request.bounds.x, request.bounds.y),
            LogicalSize::new(
                request.bounds.width.max(1.0),
                request.bounds.height.max(1.0),
            ),
        )
        .map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
fn resize<R: Runtime>(app: AppHandle<R>, request: BrowserResizeRequest) -> Result<(), String> {
    validate_browser_label(&request.label)?;
    let webview = app
        .get_webview(&request.label)
        .ok_or_else(|| "Browser webview is not available".to_string())?;
    resize_webview(&webview, &request.bounds)
}

#[tauri::command]
fn navigate<R: Runtime>(app: AppHandle<R>, request: BrowserNavigateRequest) -> Result<(), String> {
    let url = parse_browser_url(&request.url)?;
    validate_browser_label(&request.label)?;
    let webview = app
        .get_webview(&request.label)
        .ok_or_else(|| "Browser webview is not available".to_string())?;
    webview.navigate(url).map_err(|err| err.to_string())
}

#[tauri::command]
fn reload<R: Runtime>(app: AppHandle<R>, request: BrowserLabelRequest) -> Result<(), String> {
    validate_browser_label(&request.label)?;
    let webview = app
        .get_webview(&request.label)
        .ok_or_else(|| "Browser webview is not available".to_string())?;
    webview.reload().map_err(|err| err.to_string())
}

#[tauri::command]
fn back<R: Runtime>(app: AppHandle<R>, request: BrowserLabelRequest) -> Result<(), String> {
    validate_browser_label(&request.label)?;
    let webview = app
        .get_webview(&request.label)
        .ok_or_else(|| "Browser webview is not available".to_string())?;
    webview
        .eval("window.history.back();")
        .map_err(|err| err.to_string())?;
    move_browser_history(&request.label, -1);
    Ok(())
}

#[tauri::command]
fn forward<R: Runtime>(app: AppHandle<R>, request: BrowserLabelRequest) -> Result<(), String> {
    validate_browser_label(&request.label)?;
    let webview = app
        .get_webview(&request.label)
        .ok_or_else(|| "Browser webview is not available".to_string())?;
    webview
        .eval("window.history.forward();")
        .map_err(|err| err.to_string())?;
    move_browser_history(&request.label, 1);
    Ok(())
}

#[tauri::command]
async fn capture<R: Runtime>(
    app: AppHandle<R>,
    request: BrowserLabelRequest,
) -> Result<BrowserCaptureResponse, String> {
    validate_browser_label(&request.label)?;
    let webview = app
        .get_webview(&request.label)
        .ok_or_else(|| "Browser webview is not available".to_string())?;
    let (tx, rx) = oneshot::channel::<String>();
    let tx = Arc::new(Mutex::new(Some(tx)));
    let callback_tx = Arc::clone(&tx);

    webview
        .eval_with_callback(browser_capture_script(), move |payload| {
            let Ok(mut tx) = callback_tx.lock() else {
                return;
            };
            if let Some(tx) = tx.take() {
                let _ = tx.send(payload);
            }
        })
        .map_err(|err| err.to_string())?;

    let payload = timeout(Duration::from_secs(CAPTURE_TIMEOUT_SECONDS), rx)
        .await
        .map_err(|_| "Browser capture timed out".to_string())?
        .map_err(|_| "Browser capture was cancelled".to_string())?;
    serde_json::from_str(&payload).map_err(|err| format!("Invalid browser capture: {err}"))
}

#[tauri::command]
fn close<R: Runtime>(app: AppHandle<R>, request: BrowserLabelRequest) -> Result<(), String> {
    validate_browser_label(&request.label)?;
    if let Some(webview) = app.get_webview(&request.label) {
        webview.close().map_err(|err| err.to_string())?;
    }
    clear_browser_history(&request.label);
    Ok(())
}

#[tauri::command]
fn show<R: Runtime>(app: AppHandle<R>, request: BrowserLabelRequest) -> Result<(), String> {
    validate_browser_label(&request.label)?;
    let webview = app
        .get_webview(&request.label)
        .ok_or_else(|| "Browser webview is not available".to_string())?;
    webview.show().map_err(|err| err.to_string())
}

#[tauri::command]
fn hide<R: Runtime>(app: AppHandle<R>, request: BrowserLabelRequest) -> Result<(), String> {
    validate_browser_label(&request.label)?;
    let webview = app
        .get_webview(&request.label)
        .ok_or_else(|| "Browser webview is not available".to_string())?;
    webview.hide().map_err(|err| err.to_string())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::new("ripple-browser")
        .invoke_handler(tauri::generate_handler![
            open, resize, navigate, reload, back, forward, capture, close, show, hide
        ])
        .build()
}

fn resize_webview<R: Runtime>(webview: &Webview<R>, bounds: &BrowserBounds) -> Result<(), String> {
    webview
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|err| err.to_string())?;
    webview
        .set_size(LogicalSize::new(
            bounds.width.max(1.0),
            bounds.height.max(1.0),
        ))
        .map_err(|err| err.to_string())
}

impl BrowserStateEvent {
    fn new(label: String, url: String, phase: &str, flags: (bool, bool)) -> Self {
        Self {
            label,
            url,
            phase: phase.to_string(),
            title: None,
            can_go_back: flags.0,
            can_go_forward: flags.1,
            download_path: None,
            download_success: None,
        }
    }

    fn with_title(mut self, title: String) -> Self {
        self.title = Some(title);
        self
    }

    fn with_download_path(mut self, path: &PathBuf) -> Self {
        self.download_path = Some(path.display().to_string());
        self
    }

    fn with_download_success(mut self, success: bool) -> Self {
        self.download_success = Some(success);
        self
    }

    fn with_navigation_flags(mut self, flags: (bool, bool)) -> Self {
        self.can_go_back = flags.0;
        self.can_go_forward = flags.1;
        self
    }
}

fn browser_state_event(label: String, url: String, phase: &str) -> BrowserStateEvent {
    let flags = browser_navigation_flags(&label);
    BrowserStateEvent::new(label, url, phase, flags)
}

fn emit_browser_state<R: Runtime>(app: &AppHandle<R>, event: BrowserStateEvent) {
    let _ = app.emit("ripple-browser-state", event);
}

fn browser_navigation() -> &'static Mutex<HashMap<String, BrowserNavigationState>> {
    BROWSER_NAVIGATION.get_or_init(|| Mutex::new(HashMap::new()))
}

fn record_browser_url(label: &str, url: &str) -> (bool, bool) {
    let Ok(mut states) = browser_navigation().lock() else {
        return (false, false);
    };
    let state = states.entry(label.to_string()).or_default();
    if state
        .index
        .and_then(|index| state.entries.get(index))
        .map(|current| current == url)
        .unwrap_or(false)
    {
        return state.flags();
    }

    let retained = state.index.map(|index| index + 1).unwrap_or(0);
    state.entries.truncate(retained);
    state.entries.push(url.to_string());
    state.index = state.entries.len().checked_sub(1);
    state.flags()
}

fn move_browser_history(label: &str, delta: isize) -> (bool, bool) {
    let Ok(mut states) = browser_navigation().lock() else {
        return (false, false);
    };
    let Some(state) = states.get_mut(label) else {
        return (false, false);
    };
    let Some(current_index) = state.index else {
        return state.flags();
    };
    let next_index = current_index as isize + delta;
    if next_index >= 0 && (next_index as usize) < state.entries.len() {
        state.index = Some(next_index as usize);
    }
    state.flags()
}

fn browser_navigation_flags(label: &str) -> (bool, bool) {
    let Ok(states) = browser_navigation().lock() else {
        return (false, false);
    };
    states
        .get(label)
        .map(BrowserNavigationState::flags)
        .unwrap_or((false, false))
}

fn clear_browser_history(label: &str) {
    if let Ok(mut states) = browser_navigation().lock() {
        states.remove(label);
    }
}

impl BrowserNavigationState {
    fn flags(&self) -> (bool, bool) {
        let Some(index) = self.index else {
            return (false, false);
        };
        (index > 0, index + 1 < self.entries.len())
    }
}

fn browser_data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| err.to_string())?
        .join("browser-data");
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

fn parse_browser_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw.trim()).map_err(|_| "Invalid browser URL".to_string())?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        _ => Err("Browser URL must use http or https".to_string()),
    }
}

fn validate_browser_label(label: &str) -> Result<(), String> {
    if label.is_empty() || label.len() > 80 {
        return Err("Invalid browser label".to_string());
    }
    let valid = label
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'/'));
    if valid {
        Ok(())
    } else {
        Err("Invalid browser label".to_string())
    }
}

fn browser_capture_script() -> String {
    format!(
        r#"
(() => {{
  const maxChars = {max_chars};
  const normalizeText = (value) => String(value || "").replace(/\u0000/g, "").trim();
  const rawText = normalizeText(document.body ? document.body.innerText : "");
  const selectedText = normalizeText(window.getSelection ? window.getSelection().toString() : "");
  const truncated = rawText.length > maxChars;
  return {{
    url: String(window.location.href || document.URL || ""),
    title: document.title ? String(document.title) : null,
    text: truncated ? rawText.slice(0, maxChars).trimEnd() : rawText,
    selected_text: selectedText ? selectedText.slice(0, maxChars).trimEnd() : null,
    truncated,
    captured_at: new Date().toISOString()
  }};
}})()
"#,
        max_chars = MAX_CAPTURE_TEXT_CHARS
    )
}
