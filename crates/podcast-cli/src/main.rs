use std::path::PathBuf;

use podcast_cli::podcast::{run_command, CliOptions};
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
    println!("podcast CLI\n\nCommands:\n  podcast prepare-md --url <episode-url> --json");
}
