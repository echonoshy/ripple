use std::path::Path as FsPath;

use reqwest::header;
use serde_json::{json, Map, Value};
use url::{form_urlencoded, Url};

use super::{now_epoch_seconds, tail, value_as_i64, value_as_u64};

const BILIBILI_QRCODE_GENERATE_URL: &str =
    "https://passport.bilibili.com/x/passport-login/web/qrcode/generate";
const BILIBILI_QRCODE_POLL_URL: &str =
    "https://passport.bilibili.com/x/passport-login/web/qrcode/poll";
const BILIBILI_NAV_URL: &str = "https://api.bilibili.com/x/web-interface/nav";
const BILIBILI_DEFAULT_UA: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const BILIBILI_DEFAULT_REFERER: &str = "https://www.bilibili.com/";
const BILIBILI_QR_STATE_OK: i64 = 0;
const BILIBILI_QR_STATE_EXPIRED: i64 = 86038;
const BILIBILI_QR_STATE_NOT_CONFIRMED: i64 = 86090;
const BILIBILI_QR_STATE_NOT_SCANNED: i64 = 86101;

#[derive(Debug)]
pub(super) struct BilibiliQrCode {
    pub(super) qrcode_key: String,
    pub(super) qrcode_content: String,
}

#[derive(Debug)]
pub(super) struct BilibiliPollResult {
    pub(super) state: &'static str,
    pub(super) raw_code: i64,
    pub(super) raw_message: String,
    pub(super) credential_fields: Option<Value>,
}

#[derive(Debug)]
pub(super) struct BilibiliLiveCredential {
    pub(super) is_login: bool,
    pub(super) uname: String,
    pub(super) mid: u64,
    pub(super) raw_log: Option<String>,
}

pub(crate) fn read_valid_bilibili_credential_file(path: &FsPath) -> Option<Value> {
    if !path.is_file() {
        return None;
    }
    let value = serde_json::from_slice::<Value>(&std::fs::read(path).ok()?).ok()?;
    let credential = value.as_object()?;
    let sessdata = credential.get("sessdata")?.as_str()?.trim();
    if sessdata.is_empty() {
        return None;
    }
    let expires_at = value_as_u64(credential.get("expires_at")).unwrap_or(0);
    if expires_at > 0 && expires_at <= now_epoch_seconds() {
        return None;
    }
    Some(value)
}

pub(super) async fn bilibili_qrcode_generate(
    client: &reqwest::Client,
) -> anyhow::Result<BilibiliQrCode> {
    let response = bilibili_http_get_json(client, BILIBILI_QRCODE_GENERATE_URL, None).await?;
    if value_as_i64(response.get("code")).unwrap_or(-1) != 0 {
        anyhow::bail!("Bilibili QR generate returned non-zero code: {response}");
    }
    let data = response.get("data").and_then(Value::as_object);
    let qrcode_key = data
        .and_then(|data| data.get("qrcode_key"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let qrcode_content = data
        .and_then(|data| data.get("url"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if qrcode_key.is_empty() || qrcode_content.is_empty() {
        anyhow::bail!("Bilibili QR generate response is missing qrcode_key or url: {response}");
    }
    Ok(BilibiliQrCode {
        qrcode_key,
        qrcode_content,
    })
}

pub(super) fn bilibili_app_url(qrcode_content: &str) -> String {
    let encoded_content =
        form_urlencoded::byte_serialize(qrcode_content.trim().as_bytes()).collect::<String>();
    format!("bilibili://browser?url={encoded_content}")
}

pub(super) async fn bilibili_qrcode_poll(
    client: &reqwest::Client,
    qrcode_key: &str,
) -> anyhow::Result<BilibiliPollResult> {
    let mut url = Url::parse(BILIBILI_QRCODE_POLL_URL)?;
    url.query_pairs_mut()
        .append_pair("qrcode_key", qrcode_key.trim());
    let response = bilibili_http_get_json(client, url.as_str(), None).await?;
    let data = response.get("data").and_then(Value::as_object);
    let raw_code = data
        .and_then(|data| value_as_i64(data.get("code")))
        .unwrap_or(-1);
    let raw_message = data
        .and_then(|data| data.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let result = match raw_code {
        BILIBILI_QR_STATE_OK => {
            let cross_url = data
                .and_then(|data| data.get("url"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let fields = parse_bilibili_cookie_fields_from_crossdomain_url(cross_url);
            if fields
                .get("sessdata")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.trim().is_empty())
            {
                BilibiliPollResult {
                    state: "ok",
                    raw_code,
                    raw_message,
                    credential_fields: Some(fields),
                }
            } else {
                BilibiliPollResult {
                    state: "unknown",
                    raw_code,
                    raw_message: "status code 0 but SESSDATA was not present in data.url"
                        .to_string(),
                    credential_fields: None,
                }
            }
        }
        BILIBILI_QR_STATE_NOT_SCANNED => BilibiliPollResult {
            state: "waiting_scan",
            raw_code,
            raw_message,
            credential_fields: None,
        },
        BILIBILI_QR_STATE_NOT_CONFIRMED => BilibiliPollResult {
            state: "scanned",
            raw_code,
            raw_message,
            credential_fields: None,
        },
        BILIBILI_QR_STATE_EXPIRED => BilibiliPollResult {
            state: "expired",
            raw_code,
            raw_message,
            credential_fields: None,
        },
        _ => BilibiliPollResult {
            state: "unknown",
            raw_code,
            raw_message,
            credential_fields: None,
        },
    };
    Ok(result)
}

pub(super) async fn bilibili_verify_credential_live(
    client: &reqwest::Client,
    sessdata: &str,
) -> BilibiliLiveCredential {
    let response = match bilibili_http_get_json(client, BILIBILI_NAV_URL, Some(sessdata)).await {
        Ok(response) => response,
        Err(err) => {
            return BilibiliLiveCredential {
                is_login: false,
                uname: String::new(),
                mid: 0,
                raw_log: Some(format!("nav request failed: {err}")),
            }
        }
    };
    let data = response
        .get("data")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let is_login = data
        .get("isLogin")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let uname = data
        .get("uname")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let mid = value_as_u64(data.get("mid")).unwrap_or(0);
    let raw_log = (!is_login).then(|| {
        format!(
            "nav returned isLogin=false (code={})",
            value_as_i64(response.get("code")).unwrap_or(-1)
        )
    });
    BilibiliLiveCredential {
        is_login,
        uname,
        mid,
        raw_log,
    }
}

async fn bilibili_http_get_json(
    client: &reqwest::Client,
    url: &str,
    sessdata: Option<&str>,
) -> anyhow::Result<Value> {
    let mut request = client
        .get(url)
        .header(header::USER_AGENT, BILIBILI_DEFAULT_UA)
        .header(header::REFERER, BILIBILI_DEFAULT_REFERER)
        .header(header::ACCEPT, "application/json, text/plain, */*");
    if let Some(sessdata) = sessdata {
        request = request.header(header::COOKIE, format!("SESSDATA={sessdata}"));
    }
    let response = request.send().await?;
    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        anyhow::bail!(
            "Bilibili request failed: HTTP {}: {}",
            status.as_u16(),
            tail(&detail, 500)
        );
    }
    Ok(response.json::<Value>().await?)
}

pub(super) fn parse_bilibili_cookie_fields_from_crossdomain_url(raw_url: &str) -> Value {
    let Some(url) = parse_url_or_query(raw_url) else {
        return json!({});
    };
    let mut fields = Map::new();
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "SESSDATA" if !value.trim().is_empty() => {
                fields.insert("sessdata".to_string(), json!(value.to_string()));
            }
            "bili_jct" if !value.trim().is_empty() => {
                fields.insert("bili_jct".to_string(), json!(value.to_string()));
            }
            "DedeUserID" if !value.trim().is_empty() => {
                fields.insert("dede_user_id".to_string(), json!(value.to_string()));
            }
            "DedeUserID__ckMd5" if !value.trim().is_empty() => {
                fields.insert("dede_user_id_ck_md5".to_string(), json!(value.to_string()));
            }
            "Expires" => {
                if let Ok(expires_at) = value.trim().parse::<u64>() {
                    fields.insert("expires_at".to_string(), json!(expires_at));
                }
            }
            _ => {}
        }
    }
    Value::Object(fields)
}

fn parse_url_or_query(raw_url: &str) -> Option<Url> {
    let raw_url = raw_url.trim();
    if raw_url.is_empty() {
        return None;
    }
    Url::parse(raw_url).ok().or_else(|| {
        Url::parse(&format!(
            "https://ripple.invalid/?{}",
            raw_url.trim_start_matches('?')
        ))
        .ok()
    })
}
