"""FastAPI WebSocket 服务器"""

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware

from .session_manager import SessionManager
from .websocket_handler import WebSocketHandler

# 创建应用
app = FastAPI(title="Ripple WebSocket Server", version="0.1.0")

# 配置 CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 创建会话管理器和处理器
session_manager = SessionManager()
websocket_handler = WebSocketHandler(session_manager)


@app.get("/")
async def root():
    """根路径"""
    return {"message": "Ripple WebSocket Server", "version": "0.1.0"}


@app.get("/health")
async def health_check():
    """健康检查"""
    return {"status": "ok"}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket 连接端点"""
    await websocket_handler.handle_connection(websocket)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
