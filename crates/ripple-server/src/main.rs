#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = std::env::args().collect::<Vec<_>>();
    if args.get(1).map(String::as_str) == Some("migrate-files-to-sqlite") {
        if let Some(config_path) = config_arg(&args) {
            std::env::set_var("RIPPLE_CONFIG", config_path);
        }
        let config = ripple_server::config::AppConfig::load()?;
        let report = ripple_server::migration::migrate_files_to_sqlite(config).await?;
        report.print();
        return Ok(());
    }
    ripple_server::run().await
}

fn config_arg(args: &[String]) -> Option<&str> {
    args.windows(2)
        .find(|pair| pair[0] == "--config")
        .map(|pair| pair[1].as_str())
}
