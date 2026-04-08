"""WebSocket 数据模型"""

from pydantic import BaseModel


class UserMessageRequest(BaseModel):
    """用户消息请求"""

    type: str = "user_message"
    content: str
    timestamp: float


class PermissionResponse(BaseModel):
    """权限响应"""

    type: str = "permission_response"
    action: str  # "allow" | "deny" | "allow_session"
    timestamp: float


class ClearHistoryRequest(BaseModel):
    """清空历史请求"""

    type: str = "clear_history"
    timestamp: float
