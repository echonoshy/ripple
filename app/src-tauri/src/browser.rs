use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
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
use tokio::time::{sleep, timeout};
use url::Url;

const MAX_CAPTURE_TEXT_CHARS: usize = 12_000;
const CAPTURE_TIMEOUT_SECONDS: u64 = 5;
const AUTOMATION_TIMEOUT_SECONDS: u64 = 8;

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

#[derive(Debug, Deserialize)]
pub struct BrowserZoomRequest {
    pub label: String,
    pub scale: f64,
}

#[derive(Debug, Deserialize)]
pub struct BrowserAutomationRequest {
    pub label: String,
    pub command: String,
    #[serde(default)]
    pub arguments: Value,
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
    pub headings: Vec<BrowserCapturedHeading>,
    pub links: Vec<BrowserCapturedLink>,
    pub images: Vec<BrowserCapturedImage>,
    pub form_fields: Vec<BrowserCapturedFormField>,
    pub truncated: bool,
    pub captured_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BrowserCapturedHeading {
    pub level: u8,
    pub text: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BrowserCapturedLink {
    pub text: String,
    pub href: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BrowserCapturedImage {
    pub alt: String,
    pub src: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct BrowserCapturedFormField {
    pub label: String,
    pub name: String,
    #[serde(rename = "type")]
    pub field_type: String,
    pub placeholder: String,
}

#[derive(Debug, Default)]
struct BrowserNavigationState {
    entries: Vec<String>,
    index: Option<usize>,
}

static BROWSER_NAVIGATION: OnceLock<Mutex<HashMap<String, BrowserNavigationState>>> =
    OnceLock::new();

#[tauri::command]
async fn open<R: Runtime>(app: AppHandle<R>, request: BrowserOpenRequest) -> Result<(), String> {
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
        .initialization_script(browser_new_window_navigation_script())
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
fn set_zoom<R: Runtime>(app: AppHandle<R>, request: BrowserZoomRequest) -> Result<(), String> {
    validate_browser_label(&request.label)?;
    let webview = app
        .get_webview(&request.label)
        .ok_or_else(|| "Browser webview is not available".to_string())?;
    let scale = request.scale.clamp(0.5, 2.0);
    webview.set_zoom(scale).map_err(|err| err.to_string())
}

#[tauri::command]
fn clear_data<R: Runtime>(app: AppHandle<R>, request: BrowserLabelRequest) -> Result<(), String> {
    validate_browser_label(&request.label)?;
    let webview = app
        .get_webview(&request.label)
        .ok_or_else(|| "Browser webview is not available".to_string())?;
    webview
        .clear_all_browsing_data()
        .map_err(|err| err.to_string())
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
async fn run_automation<R: Runtime>(
    app: AppHandle<R>,
    request: BrowserAutomationRequest,
) -> Result<Value, String> {
    validate_browser_label(&request.label)?;
    let webview = app
        .get_webview(&request.label)
        .ok_or_else(|| "Browser webview is not available".to_string())?;

    if request.command == "browser_navigate" {
        let url = request
            .arguments
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| "browser_navigate requires url".to_string())?;
        let url = parse_browser_url(url)?;
        webview
            .navigate(url.clone())
            .map_err(|err| err.to_string())?;
        return Ok(json!({
            "ok": true,
            "observation": format!("Navigating to {url}"),
            "page": {
                "url": url.to_string(),
                "title": null,
                "text": "",
                "interactive_elements": []
            }
        }));
    }

    if request.command == "browser_wait" {
        let milliseconds = request
            .arguments
            .get("milliseconds")
            .or_else(|| request.arguments.get("ms"))
            .and_then(Value::as_u64)
            .unwrap_or(500)
            .min(10_000);
        if milliseconds > 0 {
            sleep(Duration::from_millis(milliseconds)).await;
        }
    }

    let (tx, rx) = oneshot::channel::<String>();
    let tx = Arc::new(Mutex::new(Some(tx)));
    let callback_tx = Arc::clone(&tx);

    webview
        .eval_with_callback(
            browser_automation_script(&request.command, &request.arguments)?,
            move |payload| {
                let Ok(mut tx) = callback_tx.lock() else {
                    return;
                };
                if let Some(tx) = tx.take() {
                    let _ = tx.send(payload);
                }
            },
        )
        .map_err(|err| err.to_string())?;

    let payload = timeout(Duration::from_secs(AUTOMATION_TIMEOUT_SECONDS), rx)
        .await
        .map_err(|_| "Browser automation timed out".to_string())?
        .map_err(|_| "Browser automation was cancelled".to_string())?;
    serde_json::from_str(&payload)
        .map_err(|err| format!("Invalid browser automation result: {err}"))
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
            open,
            resize,
            navigate,
            reload,
            set_zoom,
            clear_data,
            back,
            forward,
            capture,
            run_automation,
            close,
            show,
            hide
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

fn browser_new_window_navigation_script() -> String {
    r#"
(() => {
  if (window.__RIPPLE_BROWSER_NEW_WINDOW_NAVIGATION__) return;
  window.__RIPPLE_BROWSER_NEW_WINDOW_NAVIGATION__ = true;

  const toHttpUrl = (value) => {
    try {
      const url = new URL(String(value || ""), window.location.href);
      if (url.protocol !== "http:" && url.protocol !== "https:") return "";
      return url.href;
    } catch {
      return "";
    }
  };

  const navigateCurrentSurface = (value) => {
    const url = toHttpUrl(value);
    if (!url) return false;
    try {
      (window.top || window).location.assign(url);
    } catch {
      window.location.assign(url);
    }
    return true;
  };

  const originalOpen = window.open ? window.open.bind(window) : null;
  window.open = (url, target, features) => {
    if (navigateCurrentSurface(url)) return window;
    return originalOpen ? originalOpen(url, target, features) : null;
  };

  const shouldOpenInNewWindow = (event, link) => {
    const target = String(link.getAttribute("target") || "").toLowerCase();
    return target === "_blank" || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
  };

  document.addEventListener(
    "click",
    (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const target = event.target;
      const element = target && target.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement;
      if (!element || typeof element.closest !== "function") return;
      const link = element.closest("a[href]");
      if (!link || link.hasAttribute("download") || !shouldOpenInNewWindow(event, link)) return;
      const href = link.getAttribute("href");
      if (!toHttpUrl(href)) return;
      event.preventDefault();
      event.stopPropagation();
      navigateCurrentSurface(href);
    },
    true
  );
})()
"#
    .to_string()
}

fn browser_automation_script(command: &str, arguments: &Value) -> Result<String, String> {
    let command = serde_json::to_string(command).map_err(|err| err.to_string())?;
    let arguments = serde_json::to_string(arguments).map_err(|err| err.to_string())?;
    Ok(format!(
        r#"
(() => {{
  const command = {command};
  const args = {arguments};
  const maxChars = {max_chars};
  const maxItems = 80;
  const normalizeText = (value) => String(value || "").replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
  const absoluteUrl = (value) => {{
    try {{
      return value ? new URL(value, window.location.href).href : "";
    }} catch {{
      return "";
    }}
  }};
  const cssEscape = (value) => {{
    if (globalThis.CSS && typeof globalThis.CSS.escape === "function") {{
      return globalThis.CSS.escape(value);
    }}
    return String(value).replace(/["\\]/g, "\\$&");
  }};
  const isVisible = (node) => {{
    if (!node || !(node instanceof Element)) return false;
    const style = window.getComputedStyle(node);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) {{
      return false;
    }}
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }};
  const roleFor = (node) => {{
    const explicit = normalizeText(node.getAttribute("role"));
    if (explicit) return explicit;
    const tag = String(node.tagName || "").toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "input") {{
      const type = normalizeText(node.getAttribute("type")).toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button") return "button";
      return "textbox";
    }}
    return tag || "element";
  }};
  const labelFor = (node) => {{
    const aria = normalizeText(node.getAttribute("aria-label"));
    if (aria) return aria;
    const id = node.getAttribute("id");
    if (id) {{
      const label = document.querySelector(`label[for="${{cssEscape(id)}}"]`);
      const text = label ? normalizeText(label.innerText || label.textContent) : "";
      if (text) return text;
    }}
    const wrapper = node.closest("label");
    if (wrapper) {{
      const text = normalizeText(wrapper.innerText || wrapper.textContent);
      if (text) return text;
    }}
    const placeholder = normalizeText(node.getAttribute("placeholder"));
    if (placeholder) return placeholder;
    const title = normalizeText(node.getAttribute("title"));
    if (title) return title;
    return normalizeText(node.innerText || node.textContent || node.getAttribute("name"));
  }};
  const interactiveNodes = () => Array.from(document.querySelectorAll([
    "a[href]",
    "button",
    "input:not([type=hidden])",
    "textarea",
    "select",
    "[role=button]",
    "[role=link]",
    "[contenteditable=true]",
    "[tabindex]:not([tabindex='-1'])"
  ].join(","))).filter(isVisible).slice(0, maxItems);
  const nodeId = (node, index) => {{
    let id = node.getAttribute("data-ripple-browser-node-id");
    if (!id) {{
      id = `b${{index + 1}}`;
      node.setAttribute("data-ripple-browser-node-id", id);
    }}
    return id;
  }};
  const snapshot = () => {{
    const rawText = normalizeText(document.body ? document.body.innerText : "");
    const selectedText = normalizeText(window.getSelection ? window.getSelection().toString() : "");
    const truncated = rawText.length > maxChars;
    const elements = interactiveNodes().map((node, index) => {{
      const href = node.matches("a[href]") ? absoluteUrl(node.getAttribute("href")) : "";
      return {{
        id: nodeId(node, index),
        role: roleFor(node),
        text: labelFor(node).slice(0, 240),
        tag: String(node.tagName || "").toLowerCase(),
        href,
        placeholder: normalizeText(node.getAttribute("placeholder")).slice(0, 160),
        input_type: normalizeText(node.getAttribute("type")).toLowerCase().slice(0, 80)
      }};
    }});
    return {{
      url: String(window.location.href || document.URL || ""),
      title: document.title ? String(document.title) : null,
      text: truncated ? rawText.slice(0, maxChars).trimEnd() : rawText,
      selected_text: selectedText ? selectedText.slice(0, maxChars).trimEnd() : null,
      interactive_elements: elements,
      truncated,
      captured_at: new Date().toISOString()
    }};
  }};
  const targetText = (node) => normalizeText([
    node.getAttribute("data-ripple-browser-node-id"),
    node.getAttribute("aria-label"),
    node.getAttribute("placeholder"),
    node.getAttribute("title"),
    node.innerText,
    node.textContent,
    node.getAttribute("name")
  ].filter(Boolean).join(" "));
  const findTarget = (target) => {{
    const value = normalizeText(target);
    if (!value) return null;
    const byId = document.querySelector(`[data-ripple-browser-node-id="${{cssEscape(value)}}"]`);
    if (byId) return byId;
    try {{
      const bySelector = document.querySelector(value);
      if (bySelector) return bySelector;
    }} catch {{}}
    const lower = value.toLowerCase();
    return interactiveNodes().find((node) => targetText(node).toLowerCase().includes(lower)) || null;
  }};
  const dispatchInput = (node) => {{
    node.dispatchEvent(new Event("input", {{ bubbles: true }}));
    node.dispatchEvent(new Event("change", {{ bubbles: true }}));
  }};
  const fail = (message) => ({{
    ok: false,
    error: message,
    observation: message,
    page: snapshot()
  }});
  let observation = "Captured browser snapshot.";
  try {{
    if (command === "browser_snapshot" || command === "browser_wait") {{
      observation = "Captured browser snapshot.";
    }} else if (command === "browser_click") {{
      const node = findTarget(args.target);
      if (!node) return fail(`Target not found: ${{args.target || ""}}`);
      node.scrollIntoView({{ block: "center", inline: "center" }});
      node.click();
      observation = `Clicked ${{args.target}}.`;
    }} else if (command === "browser_type") {{
      const node = findTarget(args.target);
      if (!node) return fail(`Target not found: ${{args.target || ""}}`);
      node.scrollIntoView({{ block: "center", inline: "center" }});
      node.focus();
      const text = String(args.text ?? "");
      if ("value" in node) {{
        node.value = text;
        dispatchInput(node);
      }} else if (node.isContentEditable) {{
        node.textContent = text;
        dispatchInput(node);
      }} else {{
        return fail(`Target is not editable: ${{args.target || ""}}`);
      }}
      observation = `Typed into ${{args.target}}.`;
    }} else if (command === "browser_scroll") {{
      const delta = Number(args.delta_y ?? args.deltaY ?? 600);
      const node = args.target ? findTarget(args.target) : null;
      if (args.target && !node) return fail(`Target not found: ${{args.target || ""}}`);
      if (node) {{
        node.scrollBy({{ top: delta, behavior: "auto" }});
      }} else {{
        window.scrollBy({{ top: delta, behavior: "auto" }});
      }}
      observation = `Scrolled by ${{delta}} pixels.`;
    }} else if (command === "browser_key") {{
      const key = String(args.key || "");
      if (!key) return fail("browser_key requires key.");
      const target = document.activeElement || document.body;
      target.dispatchEvent(new KeyboardEvent("keydown", {{ key, bubbles: true, cancelable: true }}));
      target.dispatchEvent(new KeyboardEvent("keyup", {{ key, bubbles: true, cancelable: true }}));
      observation = `Pressed key ${{key}}.`;
    }} else {{
      return fail(`Unsupported browser command: ${{command}}`);
    }}
    return {{
      ok: true,
      observation,
      page: snapshot()
    }};
  }} catch (error) {{
    return fail(error && error.message ? error.message : String(error));
  }}
}})()
"#,
        command = command,
        arguments = arguments,
        max_chars = MAX_CAPTURE_TEXT_CHARS
    ))
}

fn browser_capture_script() -> String {
    format!(
        r#"
(() => {{
  const maxChars = {max_chars};
  const maxItems = 80;
  const normalizeText = (value) => String(value || "").replace(/\u0000/g, "").trim();
  const collect = (selector, mapper) => Array.from(document.querySelectorAll(selector))
    .map(mapper)
    .filter(Boolean)
    .slice(0, maxItems);
  const absoluteUrl = (value) => {{
    try {{
      return value ? new URL(value, window.location.href).href : "";
    }} catch {{
      return "";
    }}
  }};
  const escapeCssIdent = (value) => {{
    if (globalThis.CSS && typeof globalThis.CSS.escape === "function") {{
      return globalThis.CSS.escape(value);
    }}
    return String(value).replace(/["\\]/g, "\\$&");
  }};
  const rawText = normalizeText(document.body ? document.body.innerText : "");
  const selectedText = normalizeText(window.getSelection ? window.getSelection().toString() : "");
  const truncated = rawText.length > maxChars;
  const headings = collect("h1,h2,h3,h4,h5,h6", (node) => {{
    const text = normalizeText(node.innerText || node.textContent);
    if (!text) return null;
    const level = Number(String(node.tagName || "").replace(/[^0-9]/g, "")) || 0;
    if (level < 1 || level > 6) return null;
    return {{ level, text: text.slice(0, 240) }};
  }});
  const links = collect("a[href]", (node) => {{
    const href = absoluteUrl(node.getAttribute("href"));
    const text = normalizeText(node.innerText || node.textContent || node.getAttribute("aria-label"));
    if (!href || !text) return null;
    return {{ text: text.slice(0, 240), href }};
  }});
  const images = collect("img[src]", (node) => {{
    const src = absoluteUrl(node.getAttribute("src"));
    if (!src) return null;
    const alt = normalizeText(node.getAttribute("alt") || node.getAttribute("aria-label"));
    return {{ alt: alt.slice(0, 240), src }};
  }});
  const labelFor = (node) => {{
    const id = node.getAttribute("id");
    if (id) {{
      const label = document.querySelector(`label[for="${{escapeCssIdent(id)}}"]`);
      if (label) return normalizeText(label.innerText || label.textContent);
    }}
    const wrapper = node.closest("label");
    if (wrapper) return normalizeText(wrapper.innerText || wrapper.textContent);
    return normalizeText(node.getAttribute("aria-label") || node.getAttribute("name"));
  }};
  const formFields = collect("input,textarea,select", (node) => {{
    const disabled = node.disabled || node.getAttribute("type") === "hidden";
    if (disabled) return null;
    const label = labelFor(node);
    const name = normalizeText(node.getAttribute("name") || node.getAttribute("id"));
    const type = normalizeText(node.getAttribute("type") || node.tagName || "text").toLowerCase();
    const placeholder = normalizeText(node.getAttribute("placeholder"));
    if (!label && !name && !placeholder) return null;
    return {{
      label: label.slice(0, 240),
      name: name.slice(0, 160),
      type: type.slice(0, 80),
      placeholder: placeholder.slice(0, 240)
    }};
  }});
  return {{
    url: String(window.location.href || document.URL || ""),
    title: document.title ? String(document.title) : null,
    text: truncated ? rawText.slice(0, maxChars).trimEnd() : rawText,
    selected_text: selectedText ? selectedText.slice(0, maxChars).trimEnd() : null,
    headings,
    links,
    images,
    form_fields: formFields,
    truncated,
    captured_at: new Date().toISOString()
  }};
}})()
"#,
        max_chars = MAX_CAPTURE_TEXT_CHARS
    )
}
