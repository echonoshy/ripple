pub mod bilibili {
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use anyhow::anyhow;
    use serde_json::{json, Map, Value};
    use time::OffsetDateTime;
    use tokio::io::AsyncWriteExt;
    use url::{form_urlencoded, Url};

    const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
    const REFERER: &str = "https://www.bilibili.com/";
    const QRCODE_GENERATE_URL: &str =
        "https://passport.bilibili.com/x/passport-login/web/qrcode/generate";
    const QRCODE_POLL_URL: &str = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll";
    const NAV_URL: &str = "https://api.bilibili.com/x/web-interface/nav";
    const WORK_ROOT_DEFAULT: &str = "/workspace/.bilibili-work";
    const OUTPUT_ROOT_DEFAULT: &str = "/workspace/outputs/bilibili";
    const CREDENTIAL_FILE_DEFAULT: &str = "/workspace/.bilibili/sessdata.json";
    const CREDENTIAL_FILE_LEGACY: &str = "/workspace/.bilibili/sessdata.txt";
    const CREDENTIAL_FILE_ENV: &str = "BILIBILI_CREDENTIAL_FILE";

    const MIXIN_KEY_ENC_TAB: [usize; 64] = [
        46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19,
        29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
        22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
    ];

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct VideoInput {
        pub bvid: String,
        pub page: u64,
    }

    #[derive(Debug, Clone)]
    pub struct CliOptions {
        pub url: Option<String>,
        pub bvid: Option<String>,
        pub qrcode_key: Option<String>,
        pub credential_file: PathBuf,
        pub work_root: PathBuf,
        pub output_root: PathBuf,
        pub output_dir: Option<PathBuf>,
        pub sessdata: Option<String>,
        pub max_wait_seconds: u64,
        pub verify: bool,
        pub allow_unauthenticated: bool,
    }

    impl Default for CliOptions {
        fn default() -> Self {
            Self {
                url: None,
                bvid: None,
                qrcode_key: None,
                credential_file: default_credential_file(),
                work_root: PathBuf::from(WORK_ROOT_DEFAULT),
                output_root: PathBuf::from(OUTPUT_ROOT_DEFAULT),
                output_dir: None,
                sessdata: None,
                max_wait_seconds: 30,
                verify: false,
                allow_unauthenticated: false,
            }
        }
    }

    fn default_credential_file() -> PathBuf {
        std::env::var_os(CREDENTIAL_FILE_ENV)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(CREDENTIAL_FILE_DEFAULT))
    }

    pub async fn run_command(command: &[String], options: CliOptions) -> anyhow::Result<Value> {
        match command {
            [cmd] if cmd == "extract" => extract_command(options).await,
            [cmd] if cmd == "prepare-md" => prepare_md_command(options).await,
            [cmd, sub] if cmd == "auth" && sub == "start" => auth_start(options).await,
            [cmd, sub] if cmd == "auth" && sub == "poll" => auth_poll(options).await,
            [cmd, sub] if cmd == "auth" && sub == "status" => auth_status(options).await,
            [cmd, sub] if cmd == "auth" && sub == "logout" => auth_logout(options).await,
            [] => Err(anyhow!("missing command")),
            _ => Err(anyhow!("unknown command: {}", command.join(" "))),
        }
    }

    pub async fn extract_command(options: CliOptions) -> anyhow::Result<Value> {
        let raw_input = options
            .url
            .as_deref()
            .or(options.bvid.as_deref())
            .ok_or_else(|| anyhow!("need --url or --bvid"))?;
        let sessdata = load_sessdata(options.sessdata.as_deref(), &options.credential_file);
        let sessdata_source = sessdata.1;
        let client = reqwest::Client::new();
        let raw_input = resolve_input_if_short_url(&client, raw_input).await?;
        let parsed = parse_video_input(&raw_input)?;

        let view_data = fetch_video_view(&client, &parsed.bvid, sessdata.0.as_deref()).await?;
        let (cid, part_title) = select_page_cid(&view_data, parsed.page)?;
        let meta = extract_meta(&view_data, parsed.page, cid, &part_title);
        let view_points = extract_view_points(&view_data);

        let suffix = if parsed.page > 1 {
            format!("-p{}", parsed.page)
        } else {
            String::new()
        };
        let work_dir = options.work_root.join(format!("{}{}", parsed.bvid, suffix));
        tokio::fs::create_dir_all(&work_dir).await?;

        let mut subtitle_result = json!({"status": "need_sessdata"});
        let mut summary_result = json!({"status": "need_sessdata"});
        if let Some(sessdata) = sessdata.0.as_deref() {
            let mixin_key = get_mixin_key(&client, Some(sessdata)).await;
            match mixin_key {
                Ok(mixin_key) => {
                    subtitle_result = fetch_subtitle(&client, &mixin_key, &parsed.bvid, cid, sessdata)
                        .await
                        .unwrap_or_else(|err| {
                            json!({"status": "error", "raw_code": null, "raw_message": err.to_string()})
                        });
                    summary_result = fetch_ai_summary(
                        &client,
                        &mixin_key,
                        &parsed.bvid,
                        cid,
                        meta.pointer("/owner/mid").and_then(Value::as_u64),
                        sessdata,
                    )
                    .await
                    .unwrap_or_else(|err| {
                        json!({"status": "error", "raw_code": null, "raw_message": err.to_string()})
                    });
                }
                Err(err) => {
                    let error = json!({"status": "error", "raw_code": null, "raw_message": format!("wbi: {err}")});
                    subtitle_result = error.clone();
                    summary_result = error;
                }
            }
        }

        write_json(
            work_dir.join("meta.json"),
            &json!({"meta": meta, "view_points": view_points}),
        )
        .await?;
        write_json(work_dir.join("subtitle.json"), &subtitle_result).await?;
        write_json(work_dir.join("summary.json"), &summary_result).await?;

        let mut content_file = Value::Null;
        if subtitle_result.get("status").and_then(Value::as_str) == Some("ok") {
            let text = segments_to_text(
                subtitle_result
                    .get("segments")
                    .and_then(Value::as_array)
                    .map(Vec::as_slice)
                    .unwrap_or(&[]),
            );
            if !text.trim().is_empty() {
                tokio::fs::write(work_dir.join("content.txt"), text).await?;
                content_file = json!("content.txt");
            }
        }

        Ok(json!({
            "work_dir": work_dir.to_string_lossy(),
            "bvid": parsed.bvid,
            "p": parsed.page,
            "cid": cid,
            "title": meta.get("title").cloned().unwrap_or(Value::Null),
            "part_title": meta.get("part_title").cloned().unwrap_or(Value::Null),
            "owner": meta.get("owner").cloned().unwrap_or_else(|| json!({})),
            "duration": meta.get("duration").cloned().unwrap_or(Value::Null),
            "pubdate": meta.get("pubdate").cloned().unwrap_or(Value::Null),
            "url": meta.get("url").cloned().unwrap_or(Value::Null),
            "stat": meta.get("stat").cloned().unwrap_or_else(|| json!({})),
            "view_points_count": view_points.as_array().map(Vec::len).unwrap_or(0),
            "has_view_points": view_points.as_array().is_some_and(|items| !items.is_empty()),
            "subtitle": {
                "status": subtitle_result.get("status").cloned().unwrap_or(Value::Null),
                "lan": subtitle_result.get("lan").cloned().unwrap_or(Value::Null),
                "segments": subtitle_result.get("segments").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
                "file": "subtitle.json",
                "text_file": content_file,
            },
            "ai_summary": {
                "status": summary_result.get("status").cloned().unwrap_or(Value::Null),
                "has_summary": summary_result.get("summary").and_then(Value::as_str).is_some_and(|value| !value.trim().is_empty()),
                "outline_sections": summary_result.get("outline").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
                "file": "summary.json",
            },
            "sessdata_source": sessdata_source,
        }))
    }

    pub async fn prepare_md_command(mut options: CliOptions) -> anyhow::Result<Value> {
        let output_dir = options.output_dir.clone();
        let allow_unauthenticated = options.allow_unauthenticated;
        let output_root = options.output_root.clone();
        options.output_dir = None;
        let extracted = extract_command(options).await?;
        if extracted.get("error").is_some() {
            return Ok(extracted);
        }
        let subtitle_status = extracted
            .pointer("/subtitle/status")
            .and_then(Value::as_str);
        let summary_status = extracted
            .pointer("/ai_summary/status")
            .and_then(Value::as_str);
        if subtitle_status == Some("need_sessdata")
            && summary_status == Some("need_sessdata")
            && !allow_unauthenticated
        {
            let mut object = extracted.as_object().cloned().unwrap_or_default();
            object.insert("auth_required".to_string(), json!(true));
            object.insert(
                "error".to_string(),
                json!({
                    "code": "bilibili_auth_required",
                    "message": "Bilibili subtitles and AI summary require login. Run `bilibili auth start --json`, ask the user to scan, then run `bilibili auth poll --qrcode-key <key> --json`."
                }),
            );
            object.insert("next".to_string(), json!("run bilibili auth start"));
            return Ok(Value::Object(object));
        }

        let title = extracted
            .get("title")
            .and_then(Value::as_str)
            .or_else(|| extracted.get("bvid").and_then(Value::as_str))
            .unwrap_or("untitled");
        let bvid = extracted
            .get("bvid")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let page = extracted.get("p").and_then(Value::as_u64).unwrap_or(1);
        let pubdate = extracted
            .get("pubdate")
            .and_then(|value| {
                value
                    .as_i64()
                    .or_else(|| value.as_u64().map(|value| value as i64))
            })
            .unwrap_or_else(now_epoch_seconds);
        let date = format_date(pubdate);
        let suffix = if page > 1 {
            format!("-p{page}")
        } else {
            String::new()
        };
        let filename = format!("{date}-{bvid}{suffix}-{}.md", slugify(title, 40));
        let out_dir = prepare_md_output_dir(&output_root, output_dir, pubdate);
        tokio::fs::create_dir_all(&out_dir).await?;
        let output_path = out_dir.join(filename);
        let mut object = extracted.as_object().cloned().unwrap_or_default();
        object.insert(
            "output_path".to_string(),
            json!(output_path.to_string_lossy().to_string()),
        );
        object.insert("slug".to_string(), json!(slugify(title, 40)));
        Ok(Value::Object(object))
    }

    async fn auth_start(options: CliOptions) -> anyhow::Result<Value> {
        if let Some(credential) = read_credential_json(&options.credential_file) {
            if !credential_is_expired(&credential) {
                let public = credential_public_view(&credential);
                return Ok(json!({
                    "ok": true,
                    "stage": "authorized",
                    "data": public
                }));
            }
        }
        let client = reqwest::Client::new();
        let response = http_get_json(&client, QRCODE_GENERATE_URL, None).await?;
        if response.get("code").and_then(Value::as_i64) != Some(0) {
            return Ok(json!({"ok": false, "stage": "auth_failed", "error": response}));
        }
        let data = response.get("data").and_then(Value::as_object);
        let qrcode_key = data
            .and_then(|data| data.get("qrcode_key"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let qrcode_content = data
            .and_then(|data| data.get("url"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if qrcode_key.is_empty() || qrcode_content.is_empty() {
            return Err(anyhow!("Bilibili QR response is missing qrcode_key or url"));
        }
        let encoded_content =
            form_urlencoded::byte_serialize(qrcode_content.as_bytes()).collect::<String>();
        Ok(json!({
            "ok": true,
            "stage": "awaiting_user",
            "data": {
                "bound": false,
                "qrcode_key": qrcode_key,
                "qrcode_image_url": format!("/v1/bilibili/qrcode.png?content={encoded_content}"),
                "qrcode_content": qrcode_content,
                "app_url": format!("bilibili://browser?url={encoded_content}"),
                "expires_in_seconds": 180
            }
        }))
    }

    async fn auth_poll(options: CliOptions) -> anyhow::Result<Value> {
        let qrcode_key = options
            .qrcode_key
            .as_deref()
            .ok_or_else(|| anyhow!("--qrcode-key is required"))?;
        let client = reqwest::Client::new();
        let deadline =
            std::time::Instant::now() + Duration::from_secs(options.max_wait_seconds.clamp(1, 300));
        let mut last_state = "waiting_scan".to_string();
        let mut last_raw_message = String::new();
        while std::time::Instant::now() <= deadline {
            let poll = poll_qrcode_once(&client, qrcode_key).await?;
            last_state = poll
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            last_raw_message = poll
                .get("raw_message")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            match last_state.as_str() {
                "ok" => {
                    let mut credential = poll
                        .get("credential")
                        .and_then(Value::as_object)
                        .cloned()
                        .unwrap_or_default();
                    let sessdata = credential
                        .get("sessdata")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let live = verify_credential_live(&client, &sessdata).await;
                    credential.insert("bound_at".to_string(), json!(now_epoch_seconds()));
                    credential.insert(
                        "uname".to_string(),
                        live.get("uname").cloned().unwrap_or(Value::Null),
                    );
                    credential.insert(
                        "mid".to_string(),
                        live.get("mid").cloned().unwrap_or(Value::Null),
                    );
                    credential.insert(
                        "is_login".to_string(),
                        live.get("is_login").cloned().unwrap_or(Value::Null),
                    );
                    write_json(&options.credential_file, &Value::Object(credential.clone()))
                        .await?;
                    return Ok(json!({
                        "ok": true,
                        "stage": "authorized",
                        "data": {
                            "uname": credential.get("uname").and_then(Value::as_str).unwrap_or(""),
                            "mid": credential.get("mid").and_then(Value::as_u64).unwrap_or(0),
                            "expires_at": credential.get("expires_at").and_then(Value::as_u64).unwrap_or(0)
                        }
                    }));
                }
                "expired" => {
                    return Ok(json!({"ok": true, "stage": "expired", "data": poll}));
                }
                _ => {}
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
        Ok(json!({
            "ok": true,
            "stage": "pending",
            "data": {
                "last_state": last_state,
                "last_raw_message": last_raw_message,
                "waited_seconds": options.max_wait_seconds
            }
        }))
    }

    async fn auth_status(options: CliOptions) -> anyhow::Result<Value> {
        let Some(credential) = read_credential_json(&options.credential_file) else {
            return Ok(json!({"ok": true, "stage": "not_connected", "data": {"connected": false}}));
        };
        let mut public = credential_public_view(&credential);
        if credential_is_expired(&credential) {
            if let Some(object) = public.as_object_mut() {
                object.insert("bound".to_string(), json!(false));
                object.insert("connected".to_string(), json!(false));
            }
            return Ok(json!({"ok": true, "stage": "expired", "data": public}));
        }
        if !options.verify {
            return Ok(json!({"ok": true, "stage": "authorized", "data": public}));
        }
        let sessdata = credential
            .get("sessdata")
            .and_then(Value::as_str)
            .unwrap_or("");
        let client = reqwest::Client::new();
        let live = verify_credential_live(&client, sessdata).await;
        Ok(json!({"ok": true, "stage": "authorized", "data": public, "verify": live}))
    }

    async fn auth_logout(options: CliOptions) -> anyhow::Result<Value> {
        let removed = match tokio::fs::remove_file(&options.credential_file).await {
            Ok(()) => true,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => false,
            Err(err) => return Err(err.into()),
        };
        Ok(json!({"ok": true, "stage": "disconnected", "data": {"credential_removed": removed}}))
    }

    pub fn parse_video_input(raw: &str) -> anyhow::Result<VideoInput> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err(anyhow!("empty input"));
        }
        let page = Url::parse(trimmed)
            .ok()
            .and_then(|url| {
                url.query_pairs()
                    .find(|(key, _)| key == "p")
                    .and_then(|(_, value)| value.parse::<u64>().ok())
            })
            .unwrap_or(1)
            .max(1);
        let Some(index) = trimmed.find("BV") else {
            return Err(anyhow!("cannot find BV id in: {raw}"));
        };
        let bvid = trimmed[index..]
            .chars()
            .take_while(|ch| ch.is_ascii_alphanumeric())
            .take(12)
            .collect::<String>();
        if bvid.len() != 12 {
            return Err(anyhow!("cannot find BV id in: {raw}"));
        }
        Ok(VideoInput { bvid, page })
    }

    pub fn credential_public_view(credential: &Value) -> Value {
        json!({
            "bound": true,
            "connected": true,
            "uname": credential.get("uname").cloned().unwrap_or(Value::Null),
            "mid": credential.get("mid").cloned().unwrap_or(Value::Null),
            "expires_at": credential.get("expires_at").cloned().unwrap_or(Value::Null),
            "bound_at": credential.get("bound_at").cloned().unwrap_or(Value::Null),
            "is_login": credential.get("is_login").cloned().unwrap_or(Value::Null)
        })
    }

    pub fn slugify(title: &str, max_len: usize) -> String {
        let mut out = String::new();
        let mut last_dash = false;
        for ch in title.trim().chars() {
            let keep =
                ch.is_ascii_alphanumeric() || ch == '_' || ('\u{4e00}'..='\u{9fff}').contains(&ch);
            if keep {
                out.push(ch);
                last_dash = false;
            } else if !last_dash && !out.is_empty() {
                out.push('-');
                last_dash = true;
            }
            if out.chars().count() >= max_len {
                break;
            }
        }
        out.trim_matches('-').to_string()
    }

    pub fn prepare_md_output_dir(
        output_root: &Path,
        output_dir: Option<PathBuf>,
        pubdate: i64,
    ) -> PathBuf {
        if let Some(output_dir) = output_dir {
            return output_dir;
        }
        let date = format_date(pubdate);
        output_root.join(&date[0..4]).join(&date[5..7])
    }

    pub fn read_sessdata_from_path(path: &Path) -> Option<String> {
        let raw = std::fs::read_to_string(path).ok()?;
        let raw = raw.trim();
        if raw.is_empty() {
            return None;
        }
        if path.extension().and_then(|ext| ext.to_str()) == Some("json") || raw.starts_with('{') {
            let value = serde_json::from_str::<Value>(raw).ok()?;
            if credential_is_expired(&value) {
                return None;
            }
            value
                .get("sessdata")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        } else {
            Some(raw.to_string())
        }
    }

    pub fn parse_bilibili_cookie_fields_from_crossdomain_url(raw_url: &str) -> Value {
        let parsed =
            Url::parse(raw_url).or_else(|_| Url::parse(&format!("https://x.invalid/?{raw_url}")));
        let Ok(url) = parsed else {
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
                    if let Ok(value) = value.parse::<u64>() {
                        fields.insert("expires_at".to_string(), json!(value));
                    }
                }
                _ => {}
            }
        }
        Value::Object(fields)
    }

    pub fn format_ts(seconds: f64) -> String {
        let seconds = seconds.max(0.0) as u64;
        let h = seconds / 3600;
        let m = (seconds % 3600) / 60;
        let s = seconds % 60;
        if h > 0 {
            format!("{h:02}:{m:02}:{s:02}")
        } else {
            format!("{m:02}:{s:02}")
        }
    }

    pub fn build_mixin_key(img_key: &str, sub_key: &str) -> String {
        let raw = format!("{img_key}{sub_key}");
        let chars = raw.chars().collect::<Vec<_>>();
        MIXIN_KEY_ENC_TAB
            .iter()
            .filter_map(|index| chars.get(*index))
            .take(32)
            .collect()
    }

    pub fn wbi_sign<I>(params: I, mixin_key: &str) -> BTreeMap<String, String>
    where
        I: IntoIterator<Item = (String, String)>,
    {
        let mut signed = params.into_iter().collect::<BTreeMap<_, _>>();
        signed
            .entry("wts".to_string())
            .or_insert_with(|| now_epoch_seconds().to_string());
        let mut serializer = form_urlencoded::Serializer::new(String::new());
        for (key, value) in &signed {
            serializer.append_pair(key, value);
        }
        let query = serializer.finish();
        signed.insert(
            "w_rid".to_string(),
            md5_hex(format!("{query}{mixin_key}").as_bytes()),
        );
        signed
    }

    async fn resolve_input_if_short_url(
        client: &reqwest::Client,
        raw: &str,
    ) -> anyhow::Result<String> {
        if raw.starts_with("http") && raw.contains("b23.tv") {
            let response = client.get(raw).send().await?;
            Ok(response.url().to_string())
        } else {
            Ok(raw.to_string())
        }
    }

    fn load_sessdata(
        explicit: Option<&str>,
        credential_file: &Path,
    ) -> (Option<String>, &'static str) {
        if let Some(value) = explicit.map(str::trim).filter(|value| !value.is_empty()) {
            return (Some(value.to_string()), "arg");
        }
        if let Some(value) = read_sessdata_from_path(credential_file) {
            return (Some(value), "file");
        }
        if credential_file != Path::new(CREDENTIAL_FILE_LEGACY) {
            if let Some(value) = read_sessdata_from_path(Path::new(CREDENTIAL_FILE_LEGACY)) {
                return (Some(value), "legacy");
            }
        }
        (None, "none")
    }

    async fn fetch_video_view(
        client: &reqwest::Client,
        bvid: &str,
        sessdata: Option<&str>,
    ) -> anyhow::Result<Value> {
        let data = http_get_json(
            client,
            &format!("https://api.bilibili.com/x/web-interface/view?bvid={bvid}"),
            sessdata,
        )
        .await?;
        if data.get("code").and_then(Value::as_i64) != Some(0) {
            return Err(anyhow!(
                "view api failed: code={} msg={}",
                data.get("code").cloned().unwrap_or(Value::Null),
                data.get("message").and_then(Value::as_str).unwrap_or("")
            ));
        }
        Ok(data.get("data").cloned().unwrap_or_else(|| json!({})))
    }

    fn select_page_cid(view_data: &Value, page: u64) -> anyhow::Result<(u64, String)> {
        let pages = view_data
            .get("pages")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        if pages.is_empty() {
            return Ok((
                view_data.get("cid").and_then(Value::as_u64).unwrap_or(0),
                view_data
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            ));
        }
        let index = page
            .saturating_sub(1)
            .min(pages.len().saturating_sub(1) as u64) as usize;
        let selected = pages
            .get(index)
            .ok_or_else(|| anyhow!("page index out of range"))?;
        Ok((
            selected.get("cid").and_then(Value::as_u64).unwrap_or(0),
            selected
                .get("part")
                .and_then(Value::as_str)
                .or_else(|| view_data.get("title").and_then(Value::as_str))
                .unwrap_or("")
                .to_string(),
        ))
    }

    fn extract_meta(view_data: &Value, page: u64, cid: u64, part_title: &str) -> Value {
        let stat = view_data.get("stat").cloned().unwrap_or_else(|| json!({}));
        let owner = view_data.get("owner").cloned().unwrap_or_else(|| json!({}));
        let bvid = view_data.get("bvid").and_then(Value::as_str).unwrap_or("");
        json!({
            "bvid": bvid,
            "aid": view_data.get("aid").cloned().unwrap_or(Value::Null),
            "p": page,
            "cid": cid,
            "title": view_data.get("title").cloned().unwrap_or(Value::Null),
            "part_title": part_title,
            "desc": view_data.get("desc").cloned().unwrap_or(Value::Null),
            "pubdate": view_data.get("pubdate").cloned().unwrap_or(Value::Null),
            "duration": view_data.get("duration").cloned().unwrap_or(Value::Null),
            "owner": {
                "mid": owner.get("mid").cloned().unwrap_or(Value::Null),
                "name": owner.get("name").cloned().unwrap_or(Value::Null)
            },
            "tags": [],
            "stat": {
                "view": stat.get("view").cloned().unwrap_or(Value::Null),
                "danmaku": stat.get("danmaku").cloned().unwrap_or(Value::Null),
                "reply": stat.get("reply").cloned().unwrap_or(Value::Null),
                "favorite": stat.get("favorite").cloned().unwrap_or(Value::Null),
                "coin": stat.get("coin").cloned().unwrap_or(Value::Null),
                "share": stat.get("share").cloned().unwrap_or(Value::Null),
                "like": stat.get("like").cloned().unwrap_or(Value::Null)
            },
            "url": format!("https://www.bilibili.com/video/{bvid}{}", if page > 1 { format!("?p={page}") } else { String::new() })
        })
    }

    fn extract_view_points(view_data: &Value) -> Value {
        let values = view_data
            .get("view_points")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        Value::Array(
            values
                .iter()
                .map(|value| {
                    json!({
                        "type": value.get("type").cloned().unwrap_or(Value::Null),
                        "from": value.get("from").cloned().unwrap_or(Value::Null),
                        "to": value.get("to").cloned().unwrap_or(Value::Null),
                        "content": value.get("content").cloned().unwrap_or(Value::Null),
                        "image_url": value.get("imgUrl").or_else(|| value.get("img_url")).cloned().unwrap_or(Value::Null)
                    })
                })
                .collect(),
        )
    }

    async fn get_mixin_key(
        client: &reqwest::Client,
        sessdata: Option<&str>,
    ) -> anyhow::Result<String> {
        let data = http_get_json(client, NAV_URL, sessdata).await?;
        let wbi = data.pointer("/data/wbi_img").and_then(Value::as_object);
        let img_key = wbi
            .and_then(|wbi| wbi.get("img_url"))
            .and_then(Value::as_str)
            .and_then(|url| url.rsplit('/').next())
            .and_then(|name| name.split('.').next())
            .unwrap_or("");
        let sub_key = wbi
            .and_then(|wbi| wbi.get("sub_url"))
            .and_then(Value::as_str)
            .and_then(|url| url.rsplit('/').next())
            .and_then(|name| name.split('.').next())
            .unwrap_or("");
        if img_key.is_empty() || sub_key.is_empty() {
            return Err(anyhow!("wbi nav failed: {data}"));
        }
        Ok(build_mixin_key(img_key, sub_key))
    }

    async fn fetch_subtitle(
        client: &reqwest::Client,
        mixin_key: &str,
        bvid: &str,
        cid: u64,
        sessdata: &str,
    ) -> anyhow::Result<Value> {
        let data = wbi_get(
            client,
            "https://api.bilibili.com/x/player/wbi/v2",
            vec![
                ("bvid".to_string(), bvid.to_string()),
                ("cid".to_string(), cid.to_string()),
            ],
            mixin_key,
            Some(sessdata),
        )
        .await?;
        let code = data.get("code").and_then(Value::as_i64);
        let message = data.get("message").and_then(Value::as_str).unwrap_or("");
        if code != Some(0) {
            let status = if matches!(code, Some(-101 | -400)) {
                "need_sessdata"
            } else {
                "error"
            };
            return Ok(json!({"status": status, "raw_code": code, "raw_message": message}));
        }
        let subtitles = data
            .pointer("/data/subtitle/subtitles")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        if subtitles.is_empty() {
            return Ok(json!({"status": "empty", "raw_code": 0, "raw_message": message}));
        }
        let chosen = subtitles
            .iter()
            .min_by_key(|value| {
                subtitle_priority(value.get("lan").and_then(Value::as_str).unwrap_or(""))
            })
            .unwrap_or(&Value::Null);
        let mut subtitle_url = chosen
            .get("subtitle_url")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if subtitle_url.starts_with("//") {
            subtitle_url = format!("https:{subtitle_url}");
        }
        if subtitle_url.is_empty() {
            return Ok(
                json!({"status": "empty", "raw_code": 0, "raw_message": "subtitle_url empty"}),
            );
        }
        let raw = http_get_json(client, &subtitle_url, Some(sessdata)).await?;
        let segments = raw
            .get("body")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[])
            .iter()
            .map(|item| {
                json!({
                    "from": item.get("from").cloned().unwrap_or(Value::Null),
                    "to": item.get("to").cloned().unwrap_or(Value::Null),
                    "content": item.get("content").cloned().unwrap_or(Value::Null)
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({
            "status": "ok",
            "lan": chosen.get("lan").cloned().unwrap_or(Value::Null),
            "lan_doc": chosen.get("lan_doc").cloned().unwrap_or(Value::Null),
            "segments": segments,
            "raw_code": 0,
            "raw_message": message
        }))
    }

    fn subtitle_priority(lan: &str) -> u8 {
        match lan {
            "zh-CN" | "zh-Hans" | "zh" => 0,
            "ai-zh" => 1,
            value if value.starts_with("en") => 2,
            _ => 3,
        }
    }

    async fn fetch_ai_summary(
        client: &reqwest::Client,
        mixin_key: &str,
        bvid: &str,
        cid: u64,
        up_mid: Option<u64>,
        sessdata: &str,
    ) -> anyhow::Result<Value> {
        let mut params = vec![
            ("bvid".to_string(), bvid.to_string()),
            ("cid".to_string(), cid.to_string()),
        ];
        if let Some(up_mid) = up_mid {
            params.push(("up_mid".to_string(), up_mid.to_string()));
        }
        let data = wbi_get(
            client,
            "https://api.bilibili.com/x/web-interface/view/conclusion/get",
            params,
            mixin_key,
            Some(sessdata),
        )
        .await?;
        let code = data.get("code").and_then(Value::as_i64);
        let message = data.get("message").and_then(Value::as_str).unwrap_or("");
        if code != Some(0) {
            if code == Some(1) {
                return Ok(
                    json!({"status": "empty", "raw_code": code, "raw_message": message, "result_type": null}),
                );
            }
            let status = if matches!(code, Some(-101 | -400)) {
                "need_sessdata"
            } else {
                "error"
            };
            return Ok(json!({"status": status, "raw_code": code, "raw_message": message}));
        }
        let model_result = data
            .pointer("/data/model_result")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let summary = model_result.get("summary").cloned().unwrap_or(Value::Null);
        let outline = clean_outline(
            model_result
                .get("outline")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or(&[]),
        );
        if summary.as_str().unwrap_or("").is_empty()
            && outline.as_array().map_or(true, Vec::is_empty)
        {
            return Ok(json!({
                "status": "empty",
                "raw_code": 0,
                "raw_message": message,
                "result_type": model_result.get("result_type").cloned().unwrap_or(Value::Null)
            }));
        }
        Ok(json!({
            "status": "ok",
            "result_type": model_result.get("result_type").cloned().unwrap_or(Value::Null),
            "summary": summary,
            "outline": outline,
            "raw_code": 0,
            "raw_message": message
        }))
    }

    fn clean_outline(outline: &[Value]) -> Value {
        Value::Array(
            outline
                .iter()
                .map(|section| {
                    let parts = section
                        .get("part_outline")
                        .and_then(Value::as_array)
                        .map(Vec::as_slice)
                        .unwrap_or(&[])
                        .iter()
                        .map(|part| {
                            json!({
                                "timestamp": part.get("timestamp").cloned().unwrap_or(Value::Null),
                                "content": part.get("content").cloned().unwrap_or(Value::Null)
                            })
                        })
                        .collect::<Vec<_>>();
                    json!({
                        "title": section.get("title").cloned().unwrap_or(Value::Null),
                        "timestamp": section.get("timestamp").cloned().unwrap_or(Value::Null),
                        "parts": parts
                    })
                })
                .collect(),
        )
    }

    async fn poll_qrcode_once(client: &reqwest::Client, qrcode_key: &str) -> anyhow::Result<Value> {
        let mut url = Url::parse(QRCODE_POLL_URL)?;
        url.query_pairs_mut()
            .append_pair("qrcode_key", qrcode_key.trim());
        let response = http_get_json(client, url.as_str(), None).await?;
        let data = response.get("data").and_then(Value::as_object);
        let raw_code = data
            .and_then(|data| data.get("code"))
            .and_then(Value::as_i64)
            .unwrap_or(-1);
        let raw_message = data
            .and_then(|data| data.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let state = match raw_code {
            0 => "ok",
            86101 => "waiting_scan",
            86090 => "scanned",
            86038 => "expired",
            _ => "unknown",
        };
        let credential = if state == "ok" {
            data.and_then(|data| data.get("url"))
                .and_then(Value::as_str)
                .map(parse_bilibili_cookie_fields_from_crossdomain_url)
                .unwrap_or_else(|| json!({}))
        } else {
            Value::Null
        };
        Ok(json!({
            "state": state,
            "raw_code": raw_code,
            "raw_message": raw_message,
            "credential": credential
        }))
    }

    async fn verify_credential_live(client: &reqwest::Client, sessdata: &str) -> Value {
        match http_get_json(client, NAV_URL, Some(sessdata)).await {
            Ok(response) => {
                let data = response.get("data").cloned().unwrap_or_else(|| json!({}));
                json!({
                    "is_login": data.get("isLogin").and_then(Value::as_bool).unwrap_or(false),
                    "uname": data.get("uname").cloned().unwrap_or(Value::Null),
                    "mid": data.get("mid").cloned().unwrap_or(Value::Null)
                })
            }
            Err(err) => json!({"is_login": false, "raw_log": format!("nav request failed: {err}")}),
        }
    }

    async fn wbi_get(
        client: &reqwest::Client,
        base_url: &str,
        params: Vec<(String, String)>,
        mixin_key: &str,
        sessdata: Option<&str>,
    ) -> anyhow::Result<Value> {
        let signed = wbi_sign(params, mixin_key);
        let mut serializer = form_urlencoded::Serializer::new(String::new());
        for (key, value) in signed {
            serializer.append_pair(&key, &value);
        }
        let url = format!("{base_url}?{}", serializer.finish());
        http_get_json(client, &url, sessdata).await
    }

    async fn http_get_json(
        client: &reqwest::Client,
        url: &str,
        sessdata: Option<&str>,
    ) -> anyhow::Result<Value> {
        let mut request = client
            .get(url)
            .header(reqwest::header::USER_AGENT, UA)
            .header(reqwest::header::REFERER, REFERER)
            .header(reqwest::header::ACCEPT, "application/json, text/plain, */*");
        if let Some(sessdata) = sessdata {
            request = request.header(reqwest::header::COOKIE, format!("SESSDATA={sessdata}"));
        }
        let response = request.send().await?;
        if !response.status().is_success() {
            let status = response.status();
            let detail = response.text().await.unwrap_or_default();
            return Err(anyhow!(
                "Bilibili request failed: HTTP {}: {}",
                status.as_u16(),
                tail(&detail, 500)
            ));
        }
        Ok(response.json::<Value>().await?)
    }

    async fn write_json(path: impl AsRef<Path>, value: &Value) -> anyhow::Result<()> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let mut file = tokio::fs::File::create(path).await?;
        file.write_all(serde_json::to_string_pretty(value)?.as_bytes())
            .await?;
        file.write_all(b"\n").await?;
        Ok(())
    }

    fn read_credential_json(path: &Path) -> Option<Value> {
        serde_json::from_slice::<Value>(&std::fs::read(path).ok()?).ok()
    }

    fn credential_is_expired(credential: &Value) -> bool {
        let expires_at = credential
            .get("expires_at")
            .and_then(|value| {
                value
                    .as_i64()
                    .or_else(|| value.as_u64().map(|value| value as i64))
            })
            .unwrap_or(0);
        expires_at > 0 && expires_at <= now_epoch_seconds()
    }

    fn segments_to_text(segments: &[Value]) -> String {
        let mut lines = Vec::new();
        let mut buf = Vec::new();
        let mut buf_start = segments
            .first()
            .and_then(|segment| segment.get("from"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        for segment in segments {
            let start = segment.get("from").and_then(Value::as_f64).unwrap_or(0.0);
            let content = segment
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if content.is_empty() {
                continue;
            }
            buf.push(content.to_string());
            if start - buf_start >= 12.0 || buf.join("").chars().count() > 80 {
                lines.push(format!("[{}] {}", format_ts(buf_start), buf.join(" ")));
                buf.clear();
                buf_start = start;
            }
        }
        if !buf.is_empty() {
            lines.push(format!("[{}] {}", format_ts(buf_start), buf.join(" ")));
        }
        lines.join("\n")
    }

    fn format_date(epoch_seconds: i64) -> String {
        OffsetDateTime::from_unix_timestamp(epoch_seconds)
            .map(|time| {
                let date = time.date();
                format!(
                    "{:04}-{:02}-{:02}",
                    date.year(),
                    u8::from(date.month()),
                    date.day()
                )
            })
            .unwrap_or_else(|_| "1970-01-01".to_string())
    }

    fn now_epoch_seconds() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64
    }

    fn tail(value: &str, max_chars: usize) -> String {
        let count = value.chars().count();
        if count <= max_chars {
            return value.to_string();
        }
        value.chars().skip(count - max_chars).collect()
    }

    fn md5_hex(input: &[u8]) -> String {
        let digest = md5(input);
        let mut out = String::with_capacity(32);
        for byte in digest {
            out.push_str(&format!("{byte:02x}"));
        }
        out
    }

    fn md5(input: &[u8]) -> [u8; 16] {
        let mut msg = input.to_vec();
        let bit_len = (msg.len() as u64) * 8;
        msg.push(0x80);
        while msg.len() % 64 != 56 {
            msg.push(0);
        }
        msg.extend_from_slice(&bit_len.to_le_bytes());

        let mut a0: u32 = 0x67452301;
        let mut b0: u32 = 0xefcdab89;
        let mut c0: u32 = 0x98badcfe;
        let mut d0: u32 = 0x10325476;

        let s: [u32; 64] = [
            7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20,
            5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
            6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
        ];
        let k: [u32; 64] = [
            0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613,
            0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193,
            0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d,
            0x02441453, 0xd8a1e681, 0xe7d3fbc8, 0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
            0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122,
            0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
            0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665, 0xf4292244,
            0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
            0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb,
            0xeb86d391,
        ];

        for chunk in msg.chunks_exact(64) {
            let mut m = [0u32; 16];
            for (i, word) in m.iter_mut().enumerate() {
                let offset = i * 4;
                *word = u32::from_le_bytes([
                    chunk[offset],
                    chunk[offset + 1],
                    chunk[offset + 2],
                    chunk[offset + 3],
                ]);
            }

            let mut a = a0;
            let mut b = b0;
            let mut c = c0;
            let mut d = d0;
            for i in 0..64 {
                let (f, g) = if i < 16 {
                    ((b & c) | ((!b) & d), i)
                } else if i < 32 {
                    ((d & b) | ((!d) & c), (5 * i + 1) % 16)
                } else if i < 48 {
                    (b ^ c ^ d, (3 * i + 5) % 16)
                } else {
                    (c ^ (b | (!d)), (7 * i) % 16)
                };
                let tmp = d;
                d = c;
                c = b;
                b = b.wrapping_add(
                    a.wrapping_add(f)
                        .wrapping_add(k[i])
                        .wrapping_add(m[g])
                        .rotate_left(s[i]),
                );
                a = tmp;
            }
            a0 = a0.wrapping_add(a);
            b0 = b0.wrapping_add(b);
            c0 = c0.wrapping_add(c);
            d0 = d0.wrapping_add(d);
        }

        let mut out = [0u8; 16];
        out[0..4].copy_from_slice(&a0.to_le_bytes());
        out[4..8].copy_from_slice(&b0.to_le_bytes());
        out[8..12].copy_from_slice(&c0.to_le_bytes());
        out[12..16].copy_from_slice(&d0.to_le_bytes());
        out
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use crate::bilibili::{
        build_mixin_key, credential_public_view, format_ts,
        parse_bilibili_cookie_fields_from_crossdomain_url, parse_video_input,
        prepare_md_output_dir, read_sessdata_from_path, slugify, wbi_sign, CliOptions,
    };

    #[test]
    fn parses_bvid_and_page_from_video_url() {
        let parsed = parse_video_input(
            "https://www.bilibili.com/video/BV1z5Gd6WEST/?spm_id_from=333.934.0.0&p=3",
        )
        .expect("parse video url");

        assert_eq!(parsed.bvid, "BV1z5Gd6WEST");
        assert_eq!(parsed.page, 3);
    }

    #[test]
    fn slug_keeps_chinese_letters_digits_and_dashes() {
        assert_eq!(slugify("  A/B 测试：第 1 集!!  ", 40), "A-B-测试-第-1-集");
    }

    #[test]
    fn prepare_md_default_output_dir_uses_visible_year_month_folders() {
        let root = PathBuf::from("/workspace/outputs/bilibili");

        assert_eq!(
            prepare_md_output_dir(&root, None, 1_577_836_800),
            PathBuf::from("/workspace/outputs/bilibili/2020/01")
        );
        assert_eq!(
            prepare_md_output_dir(
                &root,
                Some(PathBuf::from("/workspace/custom")),
                1_577_836_800
            ),
            PathBuf::from("/workspace/custom")
        );
    }

    #[test]
    fn reads_sessdata_from_json_file() {
        let path = temp_path("bilibili-sessdata-json");
        std::fs::write(&path, r#"{"sessdata":" abc123 ","bili_jct":"jct"}"#).unwrap();

        let value = read_sessdata_from_path(&path).expect("read sessdata");

        assert_eq!(value, "abc123");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn ignores_expired_json_sessdata_file() {
        let path = temp_path("bilibili-expired-sessdata-json");
        std::fs::write(&path, r#"{"sessdata":"abc123","expires_at":1}"#).unwrap();

        let value = read_sessdata_from_path(&path);

        assert!(value.is_none());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn default_credential_file_uses_ripple_env_override() {
        let path = temp_path("bilibili-env-sessdata-json");
        let previous = std::env::var_os("BILIBILI_CREDENTIAL_FILE");
        std::env::set_var("BILIBILI_CREDENTIAL_FILE", &path);

        let options = CliOptions::default();

        assert_eq!(options.credential_file, path);
        if let Some(previous) = previous {
            std::env::set_var("BILIBILI_CREDENTIAL_FILE", previous);
        } else {
            std::env::remove_var("BILIBILI_CREDENTIAL_FILE");
        }
    }

    #[test]
    fn parses_cookie_fields_from_crossdomain_url() {
        let fields = parse_bilibili_cookie_fields_from_crossdomain_url(
            "https://passport.biligame.com/x/passport-login/web/crossDomain?DedeUserID=12345&DedeUserID__ckMd5=abc&Expires=1731536000&SESSDATA=a%2Cb%2Cc&bili_jct=jct",
        );

        assert_eq!(fields["sessdata"], "a,b,c");
        assert_eq!(fields["bili_jct"], "jct");
        assert_eq!(fields["dede_user_id"], "12345");
        assert_eq!(fields["dede_user_id_ck_md5"], "abc");
        assert_eq!(fields["expires_at"], 1731536000);
    }

    #[test]
    fn public_credential_view_does_not_expose_cookie_fields() {
        let public = credential_public_view(&serde_json::json!({
            "sessdata": "secret",
            "bili_jct": "csrf-secret",
            "dede_user_id": "12345",
            "uname": "tester",
            "mid": 12345,
            "expires_at": 1731536000
        }));

        assert_eq!(public["bound"], true);
        assert_eq!(public["uname"], "tester");
        assert!(public.get("sessdata").is_none());
        assert!(public.get("bili_jct").is_none());
        assert!(public.get("dede_user_id").is_none());
    }

    #[test]
    fn formats_timestamps_like_python_pipeline() {
        assert_eq!(format_ts(83.4), "01:23");
        assert_eq!(format_ts(3723.0), "01:02:03");
    }

    #[test]
    fn builds_wbi_signature_with_md5() {
        let mixin_key = build_mixin_key(
            "7cd084941338484aae1ad9425b84077c",
            "4932caff0ff746eab6f01bf08b70ac45",
        );
        let signed = wbi_sign(
            [
                ("bvid".to_string(), "BV1z5Gd6WEST".to_string()),
                ("cid".to_string(), "123".to_string()),
                ("wts".to_string(), "1710000000".to_string()),
            ],
            &mixin_key,
        );

        assert_eq!(signed.get("wts").map(String::as_str), Some("1710000000"));
        assert_eq!(
            signed.get("w_rid").map(String::as_str),
            Some("6492dd4b2e8d6376afba678f0e8319d1")
        );
    }

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("{name}-{}", uuid_like()))
    }

    fn uuid_like() -> String {
        format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )
    }
}
