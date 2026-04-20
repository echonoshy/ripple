"""FastAPI 应用入口"""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from interfaces.server.routes import router, set_session_manager
from interfaces.server.sessions import SessionManager
from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.manager import SandboxManager
from ripple.tools.builtin.bash import set_sandbox_config
from ripple.utils.config import get_config
from ripple.utils.logger import get_logger

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

        # 将沙箱配置注入 BashTool
        set_sandbox_config(sandbox_mgr.config)

        manager = SessionManager(sandbox_manager=sandbox_mgr)
        set_session_manager(manager)
        manager.start_cleanup_loop()
        logger.info(
            "Ripple Server 启动完成 (sandbox=nsjail, sessions={}, caches={})",
            sandbox_mgr.config.sessions_root,
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

    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(router)

    return app
