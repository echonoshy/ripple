"""FastAPI 应用入口"""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from interfaces.server.routes import router, set_session_manager
from interfaces.server.sessions import SessionManager
from ripple.utils.config import get_config
from ripple.utils.logger import get_logger

logger = get_logger("server.app")


def create_app() -> FastAPI:
    config = get_config()
    cors_origins = config.get("server.cors.allow_origins", ["*"])

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        manager = SessionManager()
        set_session_manager(manager)
        manager.start_cleanup_loop()
        logger.info("Ripple Server 启动完成")
        yield
        manager.stop_cleanup_loop()
        logger.info("Ripple Server 已关闭")

    app = FastAPI(
        title="Ripple Agent API",
        description="OpenAI 兼容的 Agent API Server",
        version="0.1.0",
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
