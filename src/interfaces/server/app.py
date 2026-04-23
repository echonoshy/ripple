"""FastAPI 应用入口"""

import argparse
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from interfaces.server.middleware import RequestContextMiddleware
from interfaces.server.routes import router, set_session_manager
from interfaces.server.sessions import SessionManager
from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.manager import SandboxManager
from ripple.tools.builtin.bash import set_sandbox_config, set_sandbox_manager
from ripple.utils.config import get_config
from ripple.utils.logger import get_logger, setup_logging

logger = get_logger("server.app")


def _create_sandbox_manager() -> SandboxManager:
    """从配置文件创建 SandboxManager"""
    config = get_config()
    sandbox_data = config.get("server.sandbox", {})
    if not sandbox_data:
        sandbox_data = {}

    sandbox_config = SandboxConfig.from_dict(sandbox_data)
    return SandboxManager(sandbox_config)


def create_app() -> FastAPI:
    config = get_config()
    cors_origins = config.get("server.cors.allow_origins", ["*"])

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        sandbox_mgr = _create_sandbox_manager()

        # 将沙箱配置 + manager 注入 BashTool（manager 用于 per-user lock）
        set_sandbox_config(sandbox_mgr.config)
        set_sandbox_manager(sandbox_mgr)

        manager = SessionManager(sandbox_manager=sandbox_mgr)
        set_session_manager(manager)
        manager.start_cleanup_loop()
        logger.info(
            "Ripple Server 启动完成 (sandbox=nsjail, sandboxes={}, caches={})",
            sandbox_mgr.config.sandboxes_root,
            sandbox_mgr.config.caches_root,
        )
        yield
        manager.stop_cleanup_loop()
        logger.info("Ripple Server 已关闭")

    app = FastAPI(
        title="Ripple Agent API",
        description="OpenAI 兼容的 Agent API Server（支持沙箱隔离）",
        version="0.2.0",
        lifespan=lifespan,
    )

    # RequestContextMiddleware 须最外层执行（注册在最后、outermost）：
    # 把 user_id/session_id/request_id 绑到 contextvars 后，CORS / 路由 / handler
    # 都能继承到这套上下文，所有日志自然带上这些字段。
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["X-Request-Id", "X-Ripple-Session-Id"],
    )
    app.add_middleware(RequestContextMiddleware)

    app.include_router(router)

    return app


def main() -> None:
    """启动 Ripple API Server（`ripple` 命令入口）"""
    import uvicorn

    config = get_config()
    logging_cfg = config.get("logging", {}) or {}
    setup_logging(
        level=logging_cfg.get("level", "DEBUG"),
        rotation=logging_cfg.get("rotation", "50 MB"),
        retention=logging_cfg.get("retention", "14 days"),
        access_log=bool(logging_cfg.get("access_log", True)),
        llm_log=bool(logging_cfg.get("llm_log", True)),
    )

    parser = argparse.ArgumentParser(
        prog="ripple",
        description="Ripple Agent API Server",
    )
    parser.add_argument("--host", default=None, help="监听地址")
    parser.add_argument("--port", type=int, default=None, help="监听端口")
    parser.add_argument(
        "--reload",
        action="store_true",
        default=False,
        help="开发模式自动重载",
    )
    args = parser.parse_args()

    server_host = args.host or config.get("server.host", "0.0.0.0")
    server_port = args.port or config.get("server.port", 8810)

    print(f"🌊 Ripple Server 启动中... http://{server_host}:{server_port}")
    print(f"   API 文档: http://{server_host}:{server_port}/docs")

    if args.reload:
        uvicorn.run(
            "interfaces.server.app:create_app",
            factory=True,
            host=server_host,
            port=server_port,
            reload=True,
            reload_dirs=["src"],
        )
    else:
        uvicorn.run(create_app(), host=server_host, port=server_port)


if __name__ == "__main__":
    main()
