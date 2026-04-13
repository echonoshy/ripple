# Task Management 系统使用指南

## 概述

Task Management 系统允许 Agent 将复杂任务分解为多个子任务，跟踪进度，并管理任务依赖关系。

## 核心组件

### 1. 数据模型 (`ripple.tasks.models`)

```python
class TaskStatus(str, Enum):
    PENDING = "pending"          # 待处理
    IN_PROGRESS = "in_progress"  # 进行中
    COMPLETED = "completed"      # 已完成
    DELETED = "deleted"          # 已删除

class Task(BaseModel):
    id: str                      # 任务 ID
    subject: str                 # 任务标题
    description: str             # 详细描述
    status: TaskStatus           # 任务状态
    owner: str | None            # 负责人
    blocks: list[str]            # 此任务阻塞的任务 ID
    blocked_by: list[str]        # 阻塞此任务的任务 ID
    active_form: str | None      # 进行中时的动词形式
    metadata: dict[str, Any]     # 元数据
    created_at: datetime         # 创建时间
    updated_at: datetime         # 更新时间
```

### 2. 任务管理器 (`ripple.tasks.manager`)

```python
class TaskManager:
    def create_task(subject, description, active_form=None, metadata=None) -> str
    def update_task(task_id, status=None, owner=None, ...) -> Task
    def get_task(task_id) -> Task
    def list_tasks(include_deleted=False) -> list[Task]
    def get_available_tasks(owner=None) -> list[Task]
    def delete_task(task_id)
```

### 3. 工具 (`ripple.tools.builtin.task_*`)

- **TaskCreate**: 创建新任务
- **TaskUpdate**: 更新任务状态、负责人、依赖关系
- **TaskList**: 列出所有任务
- **TaskGet**: 获取任务详细信息

## 使用场景

### 场景 1: 简单的任务分解

用户请求：
```
"添加用户认证功能，包括登录、注册和密码重置"
```

Agent 工作流：
```python
# 1. 分解任务
TaskCreate(subject="实现用户注册接口", description="...")
TaskCreate(subject="实现用户登录接口", description="...")
TaskCreate(subject="实现密码重置功能", description="...")

# 2. 执行第一个任务
TaskUpdate(taskId="1", status="in_progress")
# ... 实现注册接口 ...
TaskUpdate(taskId="1", status="completed")

# 3. 继续下一个任务
TaskUpdate(taskId="2", status="in_progress")
# ... 实现登录接口 ...
TaskUpdate(taskId="2", status="completed")

# 4. 完成最后一个任务
TaskUpdate(taskId="3", status="in_progress")
# ... 实现密码重置 ...
TaskUpdate(taskId="3", status="completed")
```

### 场景 2: 带依赖关系的任务

用户请求：
```
"重构 API 层，先设计新架构，然后迁移端点，最后更新文档"
```

Agent 工作流：
```python
# 1. 创建任务
TaskCreate(subject="设计新 API 架构", description="...")  # Task #1
TaskCreate(subject="迁移用户相关端点", description="...")  # Task #2
TaskCreate(subject="迁移订单相关端点", description="...")  # Task #3
TaskCreate(subject="更新 API 文档", description="...")     # Task #4

# 2. 设置依赖关系
TaskUpdate(taskId="2", addBlockedBy=["1"])  # Task #2 依赖 Task #1
TaskUpdate(taskId="3", addBlockedBy=["1"])  # Task #3 依赖 Task #1
TaskUpdate(taskId="4", addBlockedBy=["2", "3"])  # Task #4 依赖 Task #2 和 #3

# 3. 执行任务（按依赖顺序）
TaskUpdate(taskId="1", status="in_progress")
# ... 设计架构 ...
TaskUpdate(taskId="1", status="completed")

# 4. 现在可以并行执行 Task #2 和 #3
TaskUpdate(taskId="2", status="in_progress")
# ... 迁移用户端点 ...
TaskUpdate(taskId="2", status="completed")

TaskUpdate(taskId="3", status="in_progress")
# ... 迁移订单端点 ...
TaskUpdate(taskId="3", status="completed")

# 5. 最后更新文档
TaskUpdate(taskId="4", status="in_progress")
# ... 更新文档 ...
TaskUpdate(taskId="4", status="completed")
```

### 场景 3: 查看任务状态

```python
# 列出所有任务
TaskList()
# 输出:
# [
#   {id: "1", subject: "设计新 API 架构", status: "completed", ...},
#   {id: "2", subject: "迁移用户相关端点", status: "in_progress", ...},
#   {id: "3", subject: "迁移订单相关端点", status: "pending", ...},
#   {id: "4", subject: "更新 API 文档", status: "pending", blocked_by: ["2", "3"]},
# ]

# 获取特定任务详情
TaskGet(taskId="4")
# 输出完整的任务信息，包括描述、依赖关系等
```

## 最佳实践

### 1. 任务粒度

- ✅ **好的粒度**: "实现用户登录接口"
- ❌ **太粗**: "实现整个用户系统"
- ❌ **太细**: "在 auth.py 第 42 行添加一个函数"

### 2. 任务标题

使用祈使句，清晰描述要做什么：
- ✅ "修复登录页面的 CSS 样式问题"
- ✅ "添加用户权限检查中间件"
- ❌ "登录页面"
- ❌ "权限"

### 3. 任务描述

包含足够的上下文，让其他人（或未来的自己）能理解：
```python
TaskCreate(
    subject="优化数据库查询性能",
    description="""
    当前问题：用户列表页面加载时间超过 3 秒
    目标：将加载时间降低到 500ms 以内
    
    需要做的：
    1. 添加数据库索引到 users.email 和 users.created_at
    2. 使用分页查询替代全量查询
    3. 添加 Redis 缓存层
    
    相关文件：
    - src/api/users.py
    - src/models/user.py
    """
)
```

### 4. 及时更新状态

在开始工作前标记为 `in_progress`，完成后立即标记为 `completed`：

```python
# ✅ 好的做法
TaskUpdate(taskId="1", status="in_progress")
# ... 执行工作 ...
TaskUpdate(taskId="1", status="completed")

# ❌ 不好的做法：忘记更新状态
# ... 执行工作 ...
# （没有标记为 completed）
```

### 5. 使用依赖关系

当任务之间有明确的先后顺序时，使用 `addBlockedBy`：

```python
# 数据库迁移必须在代码部署之前完成
TaskCreate(subject="运行数据库迁移", ...)  # Task #1
TaskCreate(subject="部署新版本代码", ...)  # Task #2
TaskUpdate(taskId="2", addBlockedBy=["1"])
```

## 存储位置

任务数据存储在：
- CLI 模式: `{cwd}/.ripple/tasks.json`
- Server 模式: `{workspace}/.ripple/tasks.json`

文件格式：
```json
{
  "1": {
    "id": "1",
    "subject": "实现用户登录",
    "description": "...",
    "status": "completed",
    "owner": null,
    "blocks": [],
    "blocked_by": [],
    "active_form": "实现用户登录中",
    "metadata": {},
    "created_at": "2026-04-13T10:30:00",
    "updated_at": "2026-04-13T11:45:00"
  }
}
```

## 与其他功能集成

### 与 Agent Tool 配合

```python
# 创建任务
TaskCreate(subject="探索认证系统架构", ...)

# 使用 Agent Tool 执行探索
Agent(
    description="探索认证系统",
    prompt="搜索所有认证相关的文件，总结当前的认证流程"
)

# 标记完成
TaskUpdate(taskId="1", status="completed")
```

### 与 Plan Mode 配合（未来功能）

```python
# 进入计划模式
EnterPlanMode()

# 探索代码库
# ... 使用 Read, Grep, Glob ...

# 创建任务列表
TaskCreate(subject="...", ...)
TaskCreate(subject="...", ...)

# 提交计划
ExitPlanMode()

# 执行任务
TaskUpdate(taskId="1", status="in_progress")
# ...
```

## 故障排查

### 问题：任务文件损坏

```bash
# 备份当前任务
cp .ripple/tasks.json .ripple/tasks.json.backup

# 手动修复或删除
rm .ripple/tasks.json

# 重新开始
```

### 问题：任务 ID 冲突

任务 ID 是递增的，如果手动编辑了文件可能导致冲突。解决方法：
1. 删除 `.ripple/tasks.json`
2. 让系统重新生成

## 未来改进

- [ ] 支持任务优先级
- [ ] 支持任务标签/分类
- [ ] 支持任务时间估算
- [ ] 支持任务分配给不同的 Agent
- [ ] 支持任务模板
- [ ] 支持任务搜索和过滤
- [ ] 集成到 Web UI 显示进度条
