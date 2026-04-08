"""WebSocket 连接处理器"""

import logging
import time

from fastapi import WebSocket, WebSocketDisconnect

from ripple.api.client import OpenRouterClient
from ripple.core.agent_loop import query
from ripple.messages.cleanup import cleanup_tool_results, estimate_tokens, trim_old_messages
from ripple.messages.types import AssistantMessage, UserMessage

from .event_transformer import EventTransformer
from .session_manager import Session, SessionManager

logger = logging.getLogger(__name__)


class WebSocketHandler:
    """WebSocket 连接处理器"""

    def __init__(self, session_manager: SessionManager):
        self.session_manager = session_manager
        self.event_transformer = EventTransformer()

    async def handle_connection(self, websocket: WebSocket):
        """处理 WebSocket 连接

        Args:
            websocket: WebSocket 连接
        """
        await websocket.accept()

        # 创建会话
        session = self.session_manager.create_session(websocket)

        try:
            # 发送连接成功消息
            await websocket.send_json(
                {
                    "type": "connected",
                    "session_id": session.session_id,
                    "timestamp": time.time(),
                }
            )

            # 消息循环
            while True:
                # 接收客户端消息
                data = await websocket.receive_json()

                # 处理不同类型的消息
                if data.get("type") == "user_message":
                    await self._handle_user_message(websocket, session, data)

                elif data.get("type") == "clear_history":
                    session.messages = []
                    session.token_count = 0
                    await websocket.send_json(
                        {
                            "type": "history_cleared",
                            "timestamp": time.time(),
                        }
                    )

        except WebSocketDisconnect:
            logger.info("WebSocket disconnected")
            self.session_manager.remove_session(websocket)

        except Exception as e:
            logger.error("Connection error: %s", e, exc_info=True)
            await websocket.send_json(
                {
                    "type": "error",
                    "error": str(e),
                    "timestamp": time.time(),
                }
            )
            self.session_manager.remove_session(websocket)

    async def _handle_user_message(self, websocket: WebSocket, session: Session, data: dict):
        """处理用户消息

        Args:
            websocket: WebSocket 连接
            session: 会话
            data: 消息数据
        """
        user_input = data.get("content", "")

        if not user_input.strip():
            return

        logger.info("Received user message: %s", user_input[:100])

        try:
            # 创建 API 客户端
            client = OpenRouterClient()
            logger.info("API client created, model: %s", session.context.options.model)

            # 收集本次查询的新消息
            new_messages = []

            # 调用 query_loop
            async for item in query(
                user_input=user_input,
                context=session.context,
                client=client,
                model=session.context.options.model,
                max_turns=10,
                history_messages=session.messages,
            ):
                # 转换事件
                events = self.event_transformer.transform(item)

                if events:
                    # 处理单个事件或多个事件
                    if isinstance(events, list):
                        for event in events:
                            await websocket.send_json(event)
                    else:
                        await websocket.send_json(events)

                # 收集消息用于历史
                if isinstance(item, (AssistantMessage, UserMessage)):
                    new_messages.append(item)

            # 发送完成事件
            await websocket.send_json(
                {
                    "type": "completed",
                    "timestamp": time.time(),
                }
            )

            # 清理和更新 token 统计
            # 将消息转换为字典格式
            new_message_dicts = []
            for msg in new_messages:
                if isinstance(msg, AssistantMessage):
                    new_message_dicts.append({"role": "assistant", "content": msg.message.get("content", [])})
                elif isinstance(msg, UserMessage):
                    new_message_dicts.append({"role": "user", "content": msg.message.get("content", [])})

            cleaned_messages = cleanup_tool_results(new_message_dicts)
            session.messages.extend(cleaned_messages)

            # 更新 token 计数
            session.token_count = estimate_tokens(session.messages)

            # 智能清理：超过阈值时删除旧消息
            if session.token_count > 150_000:
                session.messages = trim_old_messages(session.messages)
                session.token_count = estimate_tokens(session.messages)

            # 发送会话统计
            await websocket.send_json(
                {
                    "type": "session_stats",
                    "token_count": session.token_count,
                    "message_count": len(session.messages),
                    "timestamp": time.time(),
                }
            )

        except Exception as e:
            logger.error("Error processing user message: %s", e, exc_info=True)
            await websocket.send_json(
                {
                    "type": "error",
                    "error": str(e),
                    "timestamp": time.time(),
                }
            )
