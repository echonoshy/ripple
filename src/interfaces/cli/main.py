"""CLI 入口"""

import asyncio

import click


@click.group()
def main():
    """Ripple - Agent Loop CLI

    让每个提问都成为涟漪的中心，每一次循环都是向解的蔓延。
    """
    from ripple.utils.config import get_config
    from ripple.utils.logger import setup_logging

    config = get_config()
    setup_logging(
        level=config.get("logging.level", "DEBUG"),
        max_bytes=config.get("logging.max_bytes", 5 * 1024 * 1024),
        backup_count=config.get("logging.backup_count", 3),
    )


@main.command()
@click.option("--model", default=None, help="模型名称")
@click.option("--max-turns", default=None, type=int, help="最大轮数")
def cli(model: str | None, max_turns: int | None):
    """启动交互式 CLI"""
    from interfaces.cli.interactive import RippleCLI

    cli_instance = RippleCLI(model=model, max_turns=max_turns)
    asyncio.run(cli_instance.run())


if __name__ == "__main__":
    main()
