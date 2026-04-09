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


@main.command()
@click.option("--host", default=None, help="监听地址")
@click.option("--port", default=None, type=int, help="监听端口")
@click.option("--reload", is_flag=True, default=False, help="开发模式自动重载")
def server(host: str | None, port: int | None, reload: bool):
    """启动 Ripple API Server"""
    import uvicorn

    from interfaces.server.app import create_app
    from ripple.utils.config import get_config

    config = get_config()
    server_host = host or config.get("server.host", "0.0.0.0")
    server_port = port or config.get("server.port", 8810)

    click.echo(f"🌊 Ripple Server 启动中... http://{server_host}:{server_port}")
    click.echo(f"   API 文档: http://{server_host}:{server_port}/docs")

    if reload:
        uvicorn.run(
            "interfaces.server.app:create_app",
            factory=True,
            host=server_host,
            port=server_port,
            reload=True,
            reload_dirs=["src"],
        )
    else:
        app = create_app()
        uvicorn.run(app, host=server_host, port=server_port)


if __name__ == "__main__":
    main()
