# 项目结构说明

## 目录结构

```
ripple/
├── src/                    # 源代码目录
│   ├── ripple/            # 核心库（可独立使用）
│   │   ├── core/          # Agent Loop 核心逻辑
│   │   ├── api/           # API 客户端封装
│   │   ├── tools/         # 工具系统
│   │   ├── skills/        # Skill 系统
│   │   ├── hooks/         # Hook 系统
│   │   ├── messages/      # 消息类型定义
│   │   ├── utils/         # 工具函数
│   │   └── permissions/   # 权限管理
│   └── interfaces/        # 接口层（用户界面）
│       ├── cli/           # 命令行接口
│       ├── server/        # HTTP/WebSocket 服务端（预留）
│       └── web/           # Web 前端（预留）
├── tests/                 # 测试文件
├── scripts/               # 辅助脚本
├── config/                # 配置文件
├── skills/                # 用户自定义 Skills
├── pyproject.toml         # 项目配置
├── CLAUDE.md              # Claude Code 指南
└── README.md              # 项目说明

```

## 设计理念

### 1. 核心库与接口分离

- **src/ripple/**: 核心库，包含所有业务逻辑，可以被任何接口层调用
- **src/interfaces/**: 接口层，提供不同的用户交互方式（CLI/Server/Web）

### 2. 模块化设计

每个模块职责清晰：
- `core/`: Agent 循环逻辑
- `api/`: 与 LLM API 通信
- `tools/`: 工具定义和执行
- `skills/`: Skill 加载和执行
- `hooks/`: Hook 验证
- `messages/`: 消息类型和转换

### 3. 可扩展性

- 新增工具：继承 `BaseTool` 并注册
- 新增接口：在 `interfaces/` 下创建新目录
- 新增 Skill：在 `skills/` 目录添加 Markdown 文件

## 接口层说明

### CLI (命令行接口)

- `main.py`: 单次命令执行
- `repl.py`: 交互式 REPL

```bash
uv run ripple run "your query"
uv run ripple repl
```

### Server (预留)

未来将实现：
- RESTful API
- WebSocket 实时通信
- 多会话管理

### Web (预留)

未来将实现：
- 现代化 Web UI
- 实时对话界面
- 工具调用可视化

## 导入规范

所有代码使用 `from ripple.xxx` 导入核心模块：

```python
from ripple.core.agent_loop import query
from ripple.api.client import OpenRouterClient
from ripple.tools.builtin.bash import BashTool
```

Python 通过 `pyproject.toml` 中的 `package-dir = {"" = "src"}` 配置找到模块。

## 开发指南

### 添加新工具

1. 在 `src/ripple/tools/builtin/` 创建新文件
2. 继承 `BaseTool` 类
3. 实现 `execute()` 方法
4. 在接口层注册工具

### 添加新接口

1. 在 `src/interfaces/` 创建新目录
2. 实现用户交互逻辑
3. 调用 `ripple.core.agent_loop.query()` 执行查询
4. 在 `pyproject.toml` 添加入口点

### 运行测试

```bash
uv run pytest                    # 运行所有测试
uv run python tests/test_basic.py  # 运行单个测试
```

### 代码质量

```bash
uv run ruff check src/ tests/    # 检查代码
uv run ruff format src/ tests/   # 格式化代码
```
