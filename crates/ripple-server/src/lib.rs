pub mod api;
pub mod auth;
pub mod capabilities;
pub mod codex;
pub mod config;
pub mod connector_runtime;
pub mod context_scope;
pub mod diagnostics;
pub mod document_preview;
pub mod jobs;
pub mod migration;
pub mod python_env;
pub mod redaction;
pub mod runtime_checks;
pub mod sandbox;
pub mod services;
pub mod sessions;
pub mod skills;
pub mod state;
pub mod storage;
pub mod user;
pub mod workspace;
pub mod workspace_changes;

use std::net::SocketAddr;

use anyhow::Context;
use axum::http::{header, HeaderName, HeaderValue, Method};
use std::future::Future;
use tokio::net::TcpListener;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing::info;

use crate::api::router;
use crate::config::{default_tracing_filter, AppConfig};
use crate::state::AppState;

pub async fn run() -> anyhow::Result<()> {
    let config = AppConfig::load().context("failed to load Ripple config")?;
    let filter = tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        tracing_subscriber::EnvFilter::try_new(config.tracing_filter())
            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(default_tracing_filter()))
    });
    let _ = tracing_subscriber::fmt().with_env_filter(filter).try_init();

    let addr: SocketAddr = format!("{}:{}", config.host, config.port)
        .parse()
        .context("invalid listen address")?;

    let listener = TcpListener::bind(addr).await?;
    serve_with_listener(listener, config, shutdown_signal()).await
}

pub async fn serve_with_listener<S>(
    listener: TcpListener,
    config: AppConfig,
    shutdown: S,
) -> anyhow::Result<()>
where
    S: Future<Output = ()> + Send + 'static,
{
    let addr = listener.local_addr()?;
    let state = AppState::new(config.clone());
    let recovered = state.jobs.recover_interrupted_stored_runs().await?;
    if recovered > 0 {
        info!(
            "marked {} queued/running job(s) as interrupted_by_restart",
            recovered
        );
    }
    let task_trigger_task = tokio::spawn(services::task_triggers::task_trigger_loop(state.clone()));
    let task_action_task = tokio::spawn(services::tasks::task_action_trigger_loop(state.clone()));
    let session_maintenance_task = tokio::spawn(state.sessions.clone().maintenance_loop());
    let codex_log_cleanup_task =
        tokio::spawn(codex::log_cleanup::maintenance_loop(state.config.clone()));
    let app = router(state)
        .layer(cors_layer(&config))
        .layer(TraceLayer::new_for_http());

    info!("Ripple Rust server listening on http://{}", addr);
    let result = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await;
    task_trigger_task.abort();
    task_action_task.abort();
    session_maintenance_task.abort();
    codex_log_cleanup_task.abort();
    result?;
    Ok(())
}

fn cors_layer(config: &AppConfig) -> CorsLayer {
    let layer = CorsLayer::new()
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
        ])
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            HeaderName::from_static("x-api-key"),
            HeaderName::from_static("x-ripple-user-id"),
        ]);
    if config.cors.allow_any_origin {
        return layer.allow_origin(Any);
    }
    let origins = config
        .cors
        .allowed_origins
        .iter()
        .filter_map(|origin| HeaderValue::from_str(origin).ok())
        .collect::<Vec<_>>();
    if origins.is_empty() {
        layer
    } else {
        layer.allow_origin(origins)
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
