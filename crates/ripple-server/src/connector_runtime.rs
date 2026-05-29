use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::process::Child;
use tokio::sync::Mutex as AsyncMutex;

#[derive(Clone, Default)]
pub struct ConnectorRuntime {
    pub(crate) gogcli_oauth: Arc<Mutex<HashMap<String, PendingGogcliOAuth>>>,
    pub(crate) feishu_setup: Arc<AsyncMutex<HashMap<String, PendingFeishuSetup>>>,
    pub(crate) bilibili_qr: Arc<Mutex<HashMap<String, PendingBilibiliQr>>>,
}

#[derive(Clone, Debug)]
pub(crate) struct PendingGogcliOAuth {
    pub(crate) user_id: String,
    pub(crate) redirect_uri: String,
    pub(crate) expires_at: u64,
}

#[derive(Debug)]
pub(crate) struct PendingFeishuSetup {
    pub(crate) process: Child,
    pub(crate) url: String,
}

#[derive(Clone, Debug)]
pub(crate) struct PendingBilibiliQr {
    pub(crate) expires_at: u64,
}
