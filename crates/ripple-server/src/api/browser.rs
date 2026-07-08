use std::net::IpAddr;
use std::time::Duration;

use axum::extract::Query;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::api::ApiError;

pub(crate) const MAX_BROWSER_TEXT_CHARS: usize = 12_000;
const MAX_BROWSER_HTML_BYTES: usize = 2 * 1024 * 1024;
const BROWSER_FETCH_TIMEOUT_SECONDS: u64 = 12;
const BROWSER_PREVIEW_BRIDGE_NONCE: &str = "rippleBrowserBridge";

#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct BrowserPageQuery {
    pub url: String,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
pub struct BrowserPageResponse {
    pub url: String,
    pub title: Option<String>,
    pub text: String,
    pub truncated: bool,
    pub embeddable: bool,
    pub preview_blocked_reason: Option<String>,
    pub preview_html: Option<String>,
    pub captured_at: String,
}

#[utoipa::path(
    get,
    path = "/browser/page",
    params(BrowserPageQuery),
    responses(
        (status = 200, description = "Fetched browser page text", body = BrowserPageResponse),
        (status = 400, description = "Invalid browser URL"),
        (status = 502, description = "Browser page fetch failed")
    )
)]
pub async fn fetch_browser_page(
    Query(query): Query<BrowserPageQuery>,
) -> Result<Json<BrowserPageResponse>, ApiError> {
    let url = validate_browser_url(&query.url)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(BROWSER_FETCH_TIMEOUT_SECONDS))
        .user_agent("RippleBrowserContext/1.0")
        .build()
        .map_err(|err| ApiError::new(StatusCode::BAD_GATEWAY, err.to_string()))?;
    let response = client
        .get(url.as_str())
        .send()
        .await
        .map_err(|err| ApiError::new(StatusCode::BAD_GATEWAY, err.to_string()))?;
    if !response.status().is_success() {
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            format!("Page returned HTTP {}", response.status()),
        ));
    }
    if response
        .content_length()
        .map(|length| length > MAX_BROWSER_HTML_BYTES as u64)
        .unwrap_or(false)
    {
        return Err(ApiError::bad_request("Page is too large"));
    }
    let preview_blocked_reason = browser_preview_blocked_reason(response.headers());
    let bytes = response
        .bytes()
        .await
        .map_err(|err| ApiError::new(StatusCode::BAD_GATEWAY, err.to_string()))?;
    if bytes.len() > MAX_BROWSER_HTML_BYTES {
        return Err(ApiError::bad_request("Page is too large"));
    }
    let html = String::from_utf8_lossy(&bytes);
    let mut page = extract_browser_page(url.as_str(), &html);
    page.embeddable = preview_blocked_reason.is_none();
    page.preview_blocked_reason = preview_blocked_reason;
    Ok(Json(page))
}

pub(crate) fn validate_browser_url(raw_url: &str) -> Result<Url, ApiError> {
    let url = Url::parse(raw_url.trim()).map_err(|_| ApiError::bad_request("Invalid URL"))?;
    match url.scheme() {
        "http" | "https" => {}
        _ => return Err(ApiError::bad_request("URL must use http or https")),
    }
    let Some(host) = url.host_str() else {
        return Err(ApiError::bad_request("URL must include a host"));
    };
    if host.eq_ignore_ascii_case("localhost") {
        return Err(ApiError::bad_request(
            "Local browser fetch URLs are not allowed",
        ));
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_private_or_local_ip(ip) {
            return Err(ApiError::bad_request(
                "Private browser fetch URLs are not allowed",
            ));
        }
    }
    Ok(url)
}

fn is_private_or_local_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_documentation()
                || ip.octets()[0] == 0
        }
        IpAddr::V6(ip) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
        }
    }
}

pub(crate) fn extract_browser_page(url: &str, html: &str) -> BrowserPageResponse {
    let title = extract_title(html);
    let mut text = strip_html_to_text(html);
    text = collapse_whitespace(&text);
    let truncated = text.len() > MAX_BROWSER_TEXT_CHARS;
    if truncated {
        text.truncate(MAX_BROWSER_TEXT_CHARS);
    }
    BrowserPageResponse {
        url: url.to_string(),
        title,
        text,
        truncated,
        embeddable: true,
        preview_blocked_reason: None,
        preview_html: Some(build_sandbox_preview_html(url, html)),
        captured_at: now_iso(),
    }
}

pub(crate) fn browser_preview_blocked_reason(headers: &HeaderMap) -> Option<String> {
    if let Some(value) = headers
        .get("x-frame-options")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_ascii_lowercase())
    {
        if value.contains("deny") || value.contains("sameorigin") || value.contains("allow-from") {
            return Some("Site blocks embedded preview with X-Frame-Options".to_string());
        }
    }

    for value in headers.get_all("content-security-policy").iter() {
        let Ok(value) = value.to_str() else {
            continue;
        };
        let lower = value.to_ascii_lowercase();
        if lower.contains("frame-ancestors")
            && (lower.contains("'none'") || lower.contains(" none"))
        {
            return Some("Site blocks embedded preview with Content-Security-Policy".to_string());
        }
    }

    None
}

fn build_sandbox_preview_html(url: &str, html: &str) -> String {
    let html = remove_meta_content_security_policy(html);
    let head_injection = format!(
        r#"<base href="{}"><meta http-equiv="Content-Security-Policy" content="default-src http: https: data: blob:; img-src http: https: data: blob:; style-src 'unsafe-inline' http: https: data:; font-src http: https: data:; script-src 'nonce-{}'; connect-src 'none'; form-action http: https:;">"#,
        escape_html_attr(url),
        BROWSER_PREVIEW_BRIDGE_NONCE
    );
    let html = inject_into_head(&html, &head_injection);
    inject_before_body_close(&html, &browser_preview_bridge_script())
}

fn remove_meta_content_security_policy(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let mut output = String::with_capacity(html.len());
    let mut cursor = 0;

    while let Some(relative_start) = lower[cursor..].find("<meta") {
        let start = cursor + relative_start;
        output.push_str(&html[cursor..start]);
        let Some(relative_end) = lower[start..].find('>') else {
            output.push_str(&html[start..]);
            return output;
        };
        let end = start + relative_end + 1;
        let tag = &lower[start..end];
        if !(tag.contains("http-equiv") && tag.contains("content-security-policy")) {
            output.push_str(&html[start..end]);
        }
        cursor = end;
    }

    output.push_str(&html[cursor..]);
    output
}

fn inject_into_head(html: &str, injection: &str) -> String {
    let lower = html.to_ascii_lowercase();
    if let Some(head_start) = lower.find("<head") {
        if let Some(relative_head_end) = lower[head_start..].find('>') {
            let insert_at = head_start + relative_head_end + 1;
            let mut output = String::with_capacity(html.len() + injection.len());
            output.push_str(&html[..insert_at]);
            output.push_str(injection);
            output.push_str(&html[insert_at..]);
            return output;
        }
    }

    format!(
        "<!doctype html><html><head>{}</head><body>{}</body></html>",
        injection, html
    )
}

fn inject_before_body_close(html: &str, injection: &str) -> String {
    let lower = html.to_ascii_lowercase();
    if let Some(close_start) = lower.rfind("</body>") {
        let mut output = String::with_capacity(html.len() + injection.len());
        output.push_str(&html[..close_start]);
        output.push_str(injection);
        output.push_str(&html[close_start..]);
        return output;
    }

    let mut output = String::with_capacity(html.len() + injection.len());
    output.push_str(html);
    output.push_str(injection);
    output
}

fn browser_preview_bridge_script() -> String {
    r#"<script nonce="__NONCE__">
(() => {
  const normalizeUrl = (value) => {
    try {
      const url = new URL(value, document.baseURI);
      if (url.protocol === "http:" || url.protocol === "https:") {
        return url.href;
      }
    } catch (_) {
      return null;
    }
    return null;
  };

  const navigate = (url) => {
    window.parent.postMessage({ type: "ripple-browser-navigate", url }, "*");
  };

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!target) return;
    const nextUrl = normalizeUrl(target.getAttribute("href") || "");
    if (!nextUrl) return;
    event.preventDefault();
    navigate(nextUrl);
  }, true);

  document.addEventListener("submit", (event) => {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (!form || form.method.toLowerCase() !== "get") return;
    const nextUrl = normalizeUrl(form.getAttribute("action") || document.URL);
    if (!nextUrl) return;
    const url = new URL(nextUrl);
    try {
      const formData = new FormData(form);
      formData.forEach((value, key) => {
        if (typeof value === "string") {
          url.searchParams.set(key, value);
        }
      });
    } catch (_) {
      return;
    }
    event.preventDefault();
    navigate(url.href);
  }, true);
})();
</script>"#
        .replace("__NONCE__", BROWSER_PREVIEW_BRIDGE_NONCE)
}

fn extract_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<title")?;
    let after_start = lower[start..].find('>')? + start + 1;
    let end = lower[after_start..].find("</title>")? + after_start;
    let title = decode_basic_entities(&html[after_start..end]);
    let title = collapse_whitespace(&title);
    (!title.is_empty()).then_some(title)
}

fn strip_html_to_text(html: &str) -> String {
    let mut text = String::with_capacity(html.len().min(MAX_BROWSER_TEXT_CHARS));
    let mut in_tag = false;
    let mut skipping_until: Option<&'static str> = None;
    let mut tag_buffer = String::new();
    let mut chars = html.chars().peekable();

    while let Some(ch) = chars.next() {
        if let Some(close_tag) = skipping_until {
            if ch == '<' {
                tag_buffer.clear();
                tag_buffer.push(ch);
                while let Some(next) = chars.peek().copied() {
                    tag_buffer.push(next);
                    chars.next();
                    if next == '>' {
                        break;
                    }
                }
                if tag_buffer.to_ascii_lowercase().starts_with(close_tag) {
                    skipping_until = None;
                    text.push(' ');
                }
            }
            continue;
        }

        if in_tag {
            if ch == '>' {
                in_tag = false;
                let normalized = tag_buffer.trim().to_ascii_lowercase();
                if normalized.starts_with("script") {
                    skipping_until = Some("</script");
                } else if normalized.starts_with("style") {
                    skipping_until = Some("</style");
                } else if is_block_tag(&normalized) {
                    text.push(' ');
                }
                tag_buffer.clear();
            } else {
                tag_buffer.push(ch);
            }
            continue;
        }

        if ch == '<' {
            in_tag = true;
            tag_buffer.clear();
            continue;
        }
        text.push(ch);
    }

    decode_basic_entities(&text)
}

fn is_block_tag(tag: &str) -> bool {
    let name = tag
        .trim_start_matches('/')
        .split_whitespace()
        .next()
        .unwrap_or("");
    matches!(
        name,
        "address"
            | "article"
            | "aside"
            | "blockquote"
            | "br"
            | "div"
            | "footer"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "header"
            | "li"
            | "main"
            | "nav"
            | "ol"
            | "p"
            | "pre"
            | "section"
            | "table"
            | "td"
            | "th"
            | "tr"
            | "ul"
    )
}

fn collapse_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn decode_basic_entities(value: &str) -> String {
    value
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

fn escape_html_attr(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_page_extracts_title_and_visible_text() {
        let html = r#"
            <!doctype html>
            <html>
              <head>
                <title>Example Article</title>
                <style>.hidden { display: none; }</style>
                <script>window.secret = "ignore me";</script>
              </head>
              <body>
                <nav>Navigation</nav>
                <main>
                  <h1>Launch Notes</h1>
                  <p>First paragraph with useful content.</p>
                  <p>Second paragraph.</p>
                </main>
              </body>
            </html>
        "#;

        let extracted = extract_browser_page("https://example.com/article", html);

        assert_eq!(extracted.title.as_deref(), Some("Example Article"));
        assert!(extracted.text.contains("Launch Notes"));
        assert!(extracted
            .text
            .contains("First paragraph with useful content."));
        assert!(!extracted.text.contains("window.secret"));
        assert!(!extracted.text.contains(".hidden"));
    }

    #[test]
    fn browser_page_rejects_non_http_urls() {
        assert!(validate_browser_url("file:///etc/passwd").is_err());
        assert!(validate_browser_url("ftp://example.com/file").is_err());
        assert!(validate_browser_url("https://example.com/article").is_ok());
    }

    #[test]
    fn browser_page_rejects_raw_private_hosts() {
        assert!(validate_browser_url("http://127.0.0.1:8810/health").is_err());
        assert!(validate_browser_url("http://10.0.0.2/internal").is_err());
        assert!(validate_browser_url("https://93.184.216.34/").is_ok());
    }

    #[test]
    fn browser_page_text_is_bounded() {
        let html = format!(
            "<html><head><title>Long</title></head><body>{}</body></html>",
            "word ".repeat(20_000)
        );

        let extracted = extract_browser_page("https://example.com/long", &html);

        assert!(extracted.text.len() <= MAX_BROWSER_TEXT_CHARS);
    }

    #[test]
    fn browser_page_detects_frame_blocking_headers() {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("x-frame-options", "deny".parse().unwrap());

        assert_eq!(
            browser_preview_blocked_reason(&headers).as_deref(),
            Some("Site blocks embedded preview with X-Frame-Options")
        );

        let mut csp_headers = axum::http::HeaderMap::new();
        csp_headers.insert(
            "content-security-policy",
            "default-src 'none'; frame-ancestors 'none'"
                .parse()
                .unwrap(),
        );

        assert_eq!(
            browser_preview_blocked_reason(&csp_headers).as_deref(),
            Some("Site blocks embedded preview with Content-Security-Policy")
        );
    }

    #[test]
    fn browser_page_builds_sandbox_preview_html() {
        let html = r#"
            <!doctype html>
            <html>
              <head>
                <meta http-equiv="Content-Security-Policy" content="script-src 'unsafe-inline'">
                <title>Example</title>
              </head>
              <body>
                <a href="/next" target="_blank">Next page</a>
              </body>
            </html>
        "#;

        let extracted = extract_browser_page("https://example.com/articles/start", html);
        let preview_html = extracted.preview_html.expect("preview html");

        assert!(preview_html.contains(r#"<base href="https://example.com/articles/start">"#));
        assert!(preview_html.contains("ripple-browser-navigate"));
        assert!(preview_html.contains("addEventListener(\"click\""));
        assert!(preview_html.contains("addEventListener(\"submit\""));
        assert!(!preview_html
            .to_ascii_lowercase()
            .contains("content=\"script-src 'unsafe-inline'\""));
    }
}
