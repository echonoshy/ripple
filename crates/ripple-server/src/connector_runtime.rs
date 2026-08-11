use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::process::Child;
use tokio::sync::Mutex as AsyncMutex;

#[derive(Clone, Default)]
pub struct ConnectorRuntime {
    pub(crate) feishu_setup: Arc<AsyncMutex<HashMap<String, PendingFeishuSetup>>>,
    pub(crate) bilibili_qr: Arc<Mutex<HashMap<String, PendingBilibiliQr>>>,
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
