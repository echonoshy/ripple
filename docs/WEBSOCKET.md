# Ripple WebSocket Server/Client

完整的 WebSocket server/client 实现，用于在 Web 界面中展示 Ripple Agent 的执行过程。

## 架构

### Server 端（FastAPI + WebSocket）
- 复用现有的 agent_loop 和工具系统
- 支持多客户端同时连接
- 每个连接维护独立的 session
- 实时推送 Agent 执行事件

### Client 端（React + Bun + Tailwind CSS v4）
- 实时展示对话流
- 工具调用过程可视化
- SubAgent 执行日志展开/折叠
- Token 使用统计

## 快速开始

### 1. 启动 Server

```bash
# 方式 1: 使用启动脚本
./scripts/start_server.sh

# 方式 2: 直接运行
uv run python -m src.interfaces.server.app
```

Server 将在 `http://localhost:8000` 启动。

### 2. 启动 Client

```bash
# 方式 1: 使用启动脚本
./scripts/start_client.sh

# 方式 2: 进入 web 目录运行
cd web
bun run dev
```

Client 将在 `http://localhost:3000` 启动。

### 3. 使用

1. 在浏览器中打开 `http://localhost:3000`
2. 确认右上角连接状态为绿色（已连接）
3. 在输入框中输入消息，例如："列出当前目录的文件"
4. 观察 Agent 的执行过程：
   - 思考中指示器
   - 助手文本消息
   - 工具调用（显示工具名称和参数）
   - 工具结果（成功/错误）
   - SubAgent 执行日志（可展开查看详细步骤）
   - Token 使用统计

## 目录结构

```
src/interfaces/server/          # Server 端
├── app.py                      # FastAPI 应用入口
├── websocket_handler.py        # WebSocket 连接处理
├── session_manager.py          # 会话管理器
├── event_transformer.py        # 事件转换器
├── permission_handler.py       # 权限处理器
└── models.py                   # 数据模型

web/                            # Client 端
├── src/
│   ├── hooks/                  # React Hooks
│   │   ├── useWebSocket.ts     # WebSocket 管理
│   │   └── useChat.ts          # 聊天状态管理
│   ├── components/             # UI 组件
│   │   ├── MessageList.tsx     # 消息列表
│   │   ├── ToolCallMessage.tsx # 工具调用消息
│   │   ├── ToolResultMessage.tsx # 工具结果消息
│   │   ├── SubAgentLog.tsx     # SubAgent 日志
│   │   ├── InputBox.tsx        # 输入框
│   │   └── TokenStats.tsx      # Token 统计
│   ├── types/
│   │   └── events.ts           # 事件类型定义
│   └── App.tsx                 # 主应用
├── index.html
├── vite.config.ts
└── package.json
```

## 通信协议

### Client → Server

```typescript
// 用户消息
{
  type: "user_message",
  content: string,
  timestamp: number
}

// 清空历史
{
  type: "clear_history",
  timestamp: number
}
```

### Server → Client

```typescript
// 连接成功
{ type: "connected", session_id: string }

// 开始思考
{ type: "thinking_start" }

// 文本内容
{ type: "text", content: string }

// 工具调用
{ type: "tool_call", tool_id: string, tool_name: string, tool_input: object }

// 工具结果
{ type: "tool_result", tool_id: string, is_error: boolean, content: string, subagent_data?: {...} }

// Token 使用
{ type: "token_usage", input_tokens: number, output_tokens: number }

// 完成
{ type: "completed" }

// 会话统计
{ type: "session_stats", token_count: number, message_count: number }

// 错误
{ type: "error", error: string }
```

## 功能特性

### 实时可视化
- 思考中动画指示器
- 流式文本显示
- 工具调用参数展示
- 工具执行结果展示

### SubAgent 支持
- 自动检测 SubAgent 执行
- 可展开/折叠的执行日志
- 显示每个工具调用步骤
- 显示最终结果和轮数

### 会话管理
- 独立的会话隔离
- 消息历史管理
- Token 自动清理（超过 150k tokens）
- 清空历史功能

### Token 统计
- 实时显示 token 使用量
- 进度条可视化
- 使用率百分比

## API 端点

- `GET /` - 根路径，返回服务器信息
- `GET /health` - 健康检查
- `WebSocket /ws` - WebSocket 连接端点

## 开发

### Server 端

```bash
# 安装依赖
uv sync

# 运行测试
uv run pytest

# 代码格式化
uv run ruff format src/interfaces/server/

# 代码检查
uv run ruff check src/interfaces/server/
```

### Client 端

```bash
cd web

# 安装依赖
bun install

# 开发模式
bun run dev

# 构建生产版本
bun run build

# 预览生产版本
bun run preview
```

## 技术栈

### Server
- FastAPI 0.115+
- Uvicorn (ASGI server)
- WebSockets 14.0+
- Python 3.13+

### Client
- React 19
- Bun (runtime & bundler)
- Vite 8
- Tailwind CSS v4
- TypeScript 5

## 故障排除

### Server 无法启动
- 检查端口 8000 是否被占用：`lsof -i :8000`
- 检查依赖是否安装：`uv sync`
- 查看错误日志

### Client 无法连接
- 确认 Server 已启动并运行在 8000 端口
- 检查浏览器控制台是否有 WebSocket 错误
- 确认 CORS 配置正确

### WebSocket 断开
- 检查网络连接
- 查看 Server 日志
- 刷新页面重新连接

## 许可证

与 Ripple 项目相同。
