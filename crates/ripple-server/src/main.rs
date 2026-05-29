#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = std::env::args().collect::<Vec<_>>();
    if args.get(1).map(String::as_str) == Some("ripple-py") {
        if let Some(config_path) = config_arg(&args) {
            std::env::set_var("RIPPLE_CONFIG", config_path);
        }
        let config = ripple_server::config::AppConfig::load()?;
        let exit_code = ripple_server::python_env::run_ripple_py_cli(config, &args[2..])?;
        if exit_code != 0 {
            std::process::exit(exit_code);
        }
        return Ok(());
    }
    if args.get(1).map(String::as_str) == Some("migrate-files-to-sqlite") {
        if let Some(config_path) = config_arg(&args) {
            std::env::set_var("RIPPLE_CONFIG", config_path);
        }
        let config = ripple_server::config::AppConfig::load()?;
        let report = ripple_server::migration::migrate_files_to_sqlite(config).await?;
        report.print();
        return Ok(());
    }
    if args.get(1).map(String::as_str) == Some("doctor") {
        if let Some(config_path) = config_arg(&args) {
            std::env::set_var("RIPPLE_CONFIG", config_path);
        }
        let config = ripple_server::config::AppConfig::load()?;
        let report = ripple_server::diagnostics::doctor_report(&config).await;
        println!("{}", serde_json::to_string_pretty(&report)?);
        if ripple_server::diagnostics::has_failed_checks(&report) {
            std::process::exit(2);
        }
        return Ok(());
    }
    ripple_server::run().await
}

fn config_arg(args: &[String]) -> Option<&str> {
    args.windows(2)
        .find(|pair| pair[0] == "--config")
        .map(|pair| pair[1].as_str())
}
