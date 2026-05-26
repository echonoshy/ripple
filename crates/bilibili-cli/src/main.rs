use std::path::PathBuf;

use bilibili_cli::bilibili::{run_command, CliOptions};
use serde_json::json;

#[tokio::main]
async fn main() {
    let (command, options) = match parse_args(std::env::args().skip(1).collect()) {
        Ok(value) => value,
        Err(err) => {
            println!(
                "{}",
                json!({"ok": false, "error": {"message": err.to_string()}})
            );
            std::process::exit(2);
        }
    };

    match run_command(&command, options).await {
        Ok(value) => {
            println!(
                "{}",
                serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string())
            );
        }
        Err(err) => {
            println!(
                "{}",
                json!({"ok": false, "error": {"message": err.to_string()}})
            );
            std::process::exit(1);
        }
    }
}

fn parse_args(args: Vec<String>) -> anyhow::Result<(Vec<String>, CliOptions)> {
    let mut command = Vec::new();
    let mut options = CliOptions::default();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--help" | "-h" => {
                print_help();
                std::process::exit(0);
            }
            "--json" => {
                index += 1;
            }
            "--url" => {
                options.url = Some(next_value(&args, &mut index, "--url")?);
            }
            "--bvid" => {
                options.bvid = Some(next_value(&args, &mut index, "--bvid")?);
            }
            "--qrcode-key" => {
                options.qrcode_key = Some(next_value(&args, &mut index, "--qrcode-key")?);
            }
            "--credential-file" | "--sessdata-file" => {
                let flag = args[index].clone();
                options.credential_file = PathBuf::from(next_value(&args, &mut index, &flag)?);
            }
            "--work-root" => {
                options.work_root = PathBuf::from(next_value(&args, &mut index, "--work-root")?);
            }
            "--output-root" => {
                options.output_root =
                    PathBuf::from(next_value(&args, &mut index, "--output-root")?);
            }
            "--output-dir" => {
                options.output_dir = Some(PathBuf::from(next_value(
                    &args,
                    &mut index,
                    "--output-dir",
                )?));
            }
            "--sessdata" => {
                options.sessdata = Some(next_value(&args, &mut index, "--sessdata")?);
            }
            "--max-wait" | "--max-wait-seconds" => {
                let flag = args[index].clone();
                options.max_wait_seconds = next_value(&args, &mut index, &flag)?
                    .parse()
                    .map_err(|_| anyhow::anyhow!("{flag} must be an integer"))?;
            }
            "--verify" => {
                options.verify = true;
                index += 1;
            }
            "--allow-unauthenticated" => {
                options.allow_unauthenticated = true;
                index += 1;
            }
            value if value.starts_with('-') => {
                anyhow::bail!("unknown flag: {value}");
            }
            value => {
                command.push(value.to_string());
                index += 1;
            }
        }
    }
    Ok((command, options))
}

fn next_value(args: &[String], index: &mut usize, flag: &str) -> anyhow::Result<String> {
    let value_index = *index + 1;
    let Some(value) = args.get(value_index) else {
        anyhow::bail!("{flag} requires a value");
    };
    *index += 2;
    Ok(value.clone())
}

fn print_help() {
    println!(
        "bilibili CLI\n\nCommands:\n  bilibili auth start --json\n  bilibili auth poll --qrcode-key <key> --json\n  bilibili auth status [--verify] --json\n  bilibili auth logout --json\n  bilibili extract --url <url-or-bv> --json\n  bilibili prepare-md --url <url-or-bv> --json"
    );
}
