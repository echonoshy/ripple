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
@click.argument("task")
@click.option("--cwd", default=None, help="工作目录")
@click.option("--model", default=None, help="模型名称")
@click.option("--max-turns", default=None, type=int, help="最大轮数")
@click.option("--stream", is_flag=True, default=False, help="实时 JSONL 流式输出")
def execute(task: str, cwd: str | None, model: str | None, max_turns: int | None, stream: bool):
    """非交互式执行任务（供其他 Agent 调用）

    输出 JSON 结果到 stdout。退出码: 0=完成, 10=需要输入, 1=错误。

    示例:
        ripple execute "读取 src/main.py 并总结"
        ripple execute "重构代码" --cwd /path/to/project --stream
    """
    from interfaces.cli.execute import execute_task

    asyncio.run(execute_task(task, cwd=cwd, model=model, max_turns=max_turns, stream=stream))


@main.command(name="continue")
@click.argument("session_id")
@click.argument("answer")
@click.option("--stream", is_flag=True, default=False, help="实时 JSONL 流式输出")
def continue_cmd(session_id: str, answer: str, stream: bool):
    """继续一个被挂起的 session

    当 execute 返回 status=needs_input 时，使用此命令提供回答并继续执行。

    示例:
        ripple continue rpl-20260409-143052-a3f2c1 "使用 FastAPI"
    """
    from interfaces.cli.execute import continue_session

    asyncio.run(continue_session(session_id, answer, stream=stream))


@main.group()
def session():
    """管理 execute 模式的 sessions"""
    pass


@session.command(name="list")
@click.option("--limit", default=20, type=int, help="显示数量")
def session_list(limit: int):
    """列出最近的 sessions"""
    from interfaces.cli.session_store import list_sessions

    sessions = list_sessions(limit=limit)
    if not sessions:
        click.echo("没有找到 sessions")
        return

    click.echo(f"{'SESSION_ID':<36} {'STATUS':<14} {'MODEL':<20} {'MESSAGES':<10} {'CREATED'}")
    click.echo("-" * 110)
    for s in sessions:
        click.echo(
            f"{s['session_id']:<36} {s['status']:<14} {s['model']:<20} {s['message_count']:<10} {s['created_at'][:19]}"
        )


@session.command(name="show")
@click.argument("session_id")
def session_show(session_id: str):
    """查看 session 详情"""
    import json

    from interfaces.cli.session_store import load_session

    data = load_session(session_id)
    if data is None:
        click.echo(f"Session '{session_id}' not found", err=True)
        raise SystemExit(1)

    info = {
        "session_id": data["session_id"],
        "status": data["status"],
        "model": data["model"],
        "cwd": data["cwd"],
        "created_at": data.get("created_at", ""),
        "message_count": len(data.get("messages", [])),
        "suspend_data": data.get("suspend_data"),
    }
    click.echo(json.dumps(info, ensure_ascii=False, indent=2))


@session.command(name="delete")
@click.argument("session_id")
def session_delete(session_id: str):
    """删除一个 session"""
    from interfaces.cli.session_store import delete_session

    if delete_session(session_id):
        click.echo(f"Session '{session_id}' 已删除")
    else:
        click.echo(f"Session '{session_id}' not found", err=True)


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
