use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::webview::PageLoadEvent;
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
struct BrowserLoadEvent {
    label: String,
    url: String,
    phase: String,
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
    let label = request.label.clone();
    let app_for_events = app.clone();
    let webview_builder = WebviewBuilder::new(&request.label, WebviewUrl::External(url))
        .on_page_load(move |_webview, payload| {
            let phase = match payload.event() {
                PageLoadEvent::Started => "started",
                PageLoadEvent::Finished => "finished",
            };
            let _ = app_for_events.emit(
                "ripple-browser-page-load",
                BrowserLoadEvent {
                    label: label.clone(),
                    url: payload.url().to_string(),
                    phase: phase.to_string(),
                },
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
            open, resize, navigate, reload, capture, close, show, hide
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
