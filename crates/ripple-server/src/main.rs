#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = std::env::args().collect::<Vec<_>>();
    if args.get(1).map(String::as_str) == Some("auth") {
        if let Some(config_path) = config_arg(&args) {
            std::env::set_var("RIPPLE_CONFIG", config_path);
        }
        let config = ripple_server::config::AppConfig::load()?;
        run_auth_command(config, parse_auth_command(&args)?).await?;
        return Ok(());
    }
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

#[derive(Debug, Clone, PartialEq, Eq)]
enum AuthCommand {
    CreateInvite {
        max_uses: u64,
        expires_days: Option<u64>,
    },
    ListUsers,
    DisableUser {
        identifier: String,
    },
    RevokeSessions {
        identifier: String,
    },
}

fn parse_auth_command(args: &[String]) -> anyhow::Result<AuthCommand> {
    let Some(command) = args.get(2).map(String::as_str) else {
        anyhow::bail!(
            "usage: ripple-server auth <create-invite|list-users|disable-user|revoke-sessions>"
        );
    };
    match command {
        "create-invite" => Ok(AuthCommand::CreateInvite {
            max_uses: parse_u64_flag(args, "--max-uses")?.unwrap_or(1).max(1),
            expires_days: parse_u64_flag(args, "--expires-days")?,
        }),
        "list-users" => Ok(AuthCommand::ListUsers),
        "disable-user" => Ok(AuthCommand::DisableUser {
            identifier: auth_identifier_arg(args, command)?,
        }),
        "revoke-sessions" => Ok(AuthCommand::RevokeSessions {
            identifier: auth_identifier_arg(args, command)?,
        }),
        other => anyhow::bail!("unknown auth command: {other}"),
    }
}

async fn run_auth_command(
    config: ripple_server::config::AppConfig,
    command: AuthCommand,
) -> anyhow::Result<()> {
    use std::sync::Arc;

    use ripple_server::storage::Storage;
    use serde_json::json;

    let storage = Storage::new(Arc::new(config))?;
    match command {
        AuthCommand::CreateInvite {
            max_uses,
            expires_days,
        } => {
            let invite = storage
                .create_user_auth_invite(max_uses, expires_days, Some("cli"))
                .await?;
            println!("{}", serde_json::to_string_pretty(&invite)?);
        }
        AuthCommand::ListUsers => {
            let users = storage
                .list_auth_users()
                .await?
                .into_iter()
                .map(|user| {
                    json!({
                        "user_id": user.user_id,
                        "login": user.login,
                        "display_name": user.display_name,
                        "status": user.status,
                        "created_at": user.created_at,
                        "updated_at": user.updated_at,
                        "disabled_at": user.disabled_at
                    })
                })
                .collect::<Vec<_>>();
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({ "users": users }))?
            );
        }
        AuthCommand::DisableUser { identifier } => {
            let disabled = storage.disable_auth_user(&identifier).await?;
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({ "ok": disabled, "identifier": identifier }))?
            );
        }
        AuthCommand::RevokeSessions { identifier } => {
            let revoked = storage.revoke_auth_sessions_for_user(&identifier).await?;
            println!(
                "{}",
                serde_json::to_string_pretty(
                    &json!({ "ok": true, "identifier": identifier, "revoked": revoked })
                )?
            );
        }
    }
    Ok(())
}

fn parse_u64_flag(args: &[String], name: &str) -> anyhow::Result<Option<u64>> {
    let Some(value) = args
        .windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1].as_str())
    else {
        return Ok(None);
    };
    value
        .parse::<u64>()
        .map(Some)
        .map_err(|err| anyhow::anyhow!("{name} must be a positive integer: {err}"))
}

fn auth_identifier_arg(args: &[String], command: &str) -> anyhow::Result<String> {
    let Some(value) = args.get(3).map(String::as_str) else {
        anyhow::bail!("usage: ripple-server auth {command} <login-or-user-id>");
    };
    if value.starts_with("--") || value.trim().is_empty() {
        anyhow::bail!("usage: ripple-server auth {command} <login-or-user-id>");
    }
    Ok(value.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_auth_create_invite_flags() {
        let args = vec![
            "ripple-server".to_string(),
            "auth".to_string(),
            "create-invite".to_string(),
            "--max-uses".to_string(),
            "3".to_string(),
            "--expires-days".to_string(),
            "7".to_string(),
        ];

        assert_eq!(
            parse_auth_command(&args).unwrap(),
            AuthCommand::CreateInvite {
                max_uses: 3,
                expires_days: Some(7)
            }
        );
    }
}
