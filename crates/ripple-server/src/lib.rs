pub mod api;
pub mod codex;
pub mod config;
pub mod jobs;
pub mod sandbox;
pub mod sessions;
pub mod skills;
pub mod state;
pub mod user;
pub mod workspace;

use std::net::SocketAddr;

use anyhow::Context;
use std::future::Future;
use tokio::net::TcpListener;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use tracing::info;

use crate::api::router;
use crate::config::AppConfig;
use crate::state::AppState;

pub async fn run() -> anyhow::Result<()> {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "ripple_server=debug,tower_http=info,axum=info".into()),
        )
        .try_init();

    let config = AppConfig::load().context("failed to load Ripple config")?;
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
    let state = AppState::new(config);
    let schedule_task = tokio::spawn(api::schedules::schedule_trigger_loop(state.clone()));
    let session_maintenance_task = tokio::spawn(state.sessions.clone().maintenance_loop());
    let app = router(state)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http());

    info!("Ripple Rust server listening on http://{}", addr);
    let result = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await;
    schedule_task.abort();
    session_maintenance_task.abort();
    result?;
    Ok(())
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
