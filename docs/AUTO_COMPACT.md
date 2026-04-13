# Auto-Compact 系统使用指南

## 概述

Auto-Compact 系统在消息历史超过 token 限制时自动压缩，使 Agent 能够支持长对话（50+ 轮）而不会因为上下文过长而失败。

## 核心组件

### 1. Token 计数器 (`ripple.utils.token_counter`)

```python
def estimate_tokens(text: str) -> int
    """快速估算文本的 token 数量（1 token ≈ 4 字符）"""

def estimate_message_tokens(message: Message) -> int
    """估算单条消息的 token 数量"""

def estimate_messages_tokens(messages: list[Message]) -> int
    """估算消息列表的总 token 数量"""
```

### 2. 自动压缩器 (`ripple.compact.auto_compact`)

```python
class AutoCompactor:
    THRESHOLD = 150_000        # 触发压缩的阈值
    PRESERVED_TURNS = 10       # 保留最近的消息轮数
    
    def should_compact(messages) -> bool
        """检查是否需要压缩"""
    
    async def compact(messages, context) -> list[Message]
        """压缩消息历史"""
```

## 工作原理

### 压缩策略

当前实现使用**简单截断策略**：

1. **检测**: 每轮对话开始前，估算消息历史的 token 数量
2. **触发**: 如果超过 150,000 tokens，触发压缩
3. **保留**: 保留最近 10 轮对话
4. **丢弃**: 丢弃更早的消息
5. **边界**: 插入压缩边界消息，告知 Agent 历史已压缩

### 压缩流程

```
原始消息历史 (100 条消息, 200k tokens)
    ↓
检测到超过阈值 (150k)
    ↓
保留最近 10 条消息 (10k tokens)
丢弃前 90 条消息 (190k tokens)
    ↓
插入压缩边界消息
    ↓
压缩后历史 (11 条消息, 11k tokens)
```

### 压缩边界消息

```
[Conversation history compacted]

90 older messages (190,000 tokens) have been removed to stay within context limits.

The most recent 10 messages are preserved below. Continue the conversation naturally.
```

## 集成到 Agent Loop

压缩器已集成到 `agent_loop.py` 中，在每轮对话开始前自动检查：

```python
while True:
    # 阶段 0: 检查是否需要压缩
    if compactor.should_compact(state.messages):
        logger.info("开始压缩消息历史...")
        compacted_messages = await compactor.compact(
            state.messages, 
            state.tool_use_context
        )
        state = state.with_messages(compacted_messages)
        yield compacted_messages[0]  # 压缩边界消息
    
    # 阶段 1: 调用模型
    ...
```

## 性能数据

基于测试结果：

- **输入**: 100 条消息，54,500 tokens
- **输出**: 11 条消息（1 边界 + 10 保留），5,550 tokens
- **节省**: 48,950 tokens (89.8%)

## 配置选项

### 调整阈值

```python
from ripple.compact import AutoCompactor

# 创建自定义压缩器
compactor = AutoCompactor(
    threshold=100_000,      # 更低的阈值，更频繁压缩
    preserved_turns=15      # 保留更多最近消息
)
```

### 全局配置

```python
from ripple.compact import get_global_compactor

# 获取全局压缩器
compactor = get_global_compactor()

# 修改配置
compactor.threshold = 120_000
compactor.preserved_turns = 12
```

## 使用场景

### 场景 1: 长时间对话

用户进行了 50+ 轮对话，讨论复杂的代码重构：

```
Turn 1-40: 探索代码库，理解架构 (120k tokens)
Turn 41: 触发压缩，保留最近 10 轮
Turn 42-60: 继续重构工作 (不会因为历史过长而失败)
```

### 场景 2: 大量工具调用

Agent 执行了大量文件读取和搜索操作：

```
每次 Read 工具返回 2000 行代码 ≈ 8k tokens
执行 20 次 Read = 160k tokens
触发压缩，只保留最近的结果
继续工作
```

### 场景 3: 复杂任务分解

用户要求实现大型功能，Agent 创建了很多任务：

```
TaskCreate × 20 (创建 20 个任务)
逐个执行，每个任务多轮对话
历史不断增长
自动压缩保持在限制内
```

## 限制和注意事项

### 当前限制

1. **简单策略**: 只保留最近 N 轮，不考虑重要性
2. **无摘要**: 丢弃的消息没有生成摘要
3. **固定保留**: 不根据内容动态调整保留数量
4. **估算不精确**: 使用启发式规则，不是真实 token 计数

### 可能的问题

**问题 1: 重要上下文丢失**

如果用户在第 5 轮提供了关键信息，但现在是第 50 轮，压缩后这些信息会丢失。

**解决方案**:
- 使用 Memory 系统保存重要信息
- 实现智能摘要（未来功能）
- 用户可以重新提供关键信息

**问题 2: 任务依赖丢失**

如果任务 A 的结果在压缩前，任务 B 依赖它，Agent 可能不记得。

**解决方案**:
- 使用 Task Management 系统跟踪任务
- 任务描述中包含足够的上下文
- 必要时重新读取相关文件

## 未来改进

### 智能摘要（优先级：高）

使用 Haiku 生成旧消息的摘要：

```python
async def compact_with_summary(messages, context):
    # 1. 提取旧消息
    old_messages = messages[:-10]
    
    # 2. 使用 Haiku 生成摘要
    summary = await generate_summary(old_messages)
    
    # 3. 创建包含摘要的边界消息
    boundary = create_system_message(f"""
    [Conversation history compacted]
    
    Summary of previous conversation:
    {summary}
    
    Recent messages preserved below.
    """)
    
    return [boundary, *messages[-10:]]
```

### 重要性评分（优先级：中）

根据消息重要性选择保留：

- 用户明确的需求
- 关键决策点
- 错误和修复
- 任务创建和完成

### 动态保留（优先级：中）

根据 token 预算动态调整保留数量：

```python
def calculate_preserved_turns(messages, target_tokens):
    """计算应该保留多少轮才能达到目标 token 数"""
    ...
```

### Prompt Caching 集成（优先级：低）

与 Anthropic 的 prompt caching 集成，减少重复计算：

```python
# 标记压缩边界为 cache_control
boundary = {
    "role": "system",
    "content": summary,
    "cache_control": {"type": "ephemeral"}
}
```

## 监控和调试

### 日志输出

压缩器会输出详细日志：

```
[INFO] 消息历史达到 154,230 tokens，超过阈值 150,000，需要压缩
[INFO] 压缩消息历史: 丢弃 90 条旧消息 (约 144,000 tokens)，保留最近 10 条
[INFO] 压缩完成，当前消息数: 11
```

### 检查压缩状态

```python
from ripple.utils.token_counter import estimate_messages_tokens

# 检查当前 token 数量
tokens = estimate_messages_tokens(messages)
print(f"当前消息历史: {len(messages)} 条, {tokens:,} tokens")

# 检查是否需要压缩
from ripple.compact import get_global_compactor
compactor = get_global_compactor()
if compactor.should_compact(messages):
    print("需要压缩")
```

### 测试压缩

```bash
# 运行测试
python tests/test_auto_compact.py

# 输出:
# 创建了 100 条消息
# 压缩前 token 数量: 54,500
# 是否需要压缩: True
# 压缩后消息数量: 11
# 压缩后 token 数量: 5,550
# 节省了: 48,950 tokens (89.8%)
# ✅ 自动压缩测试通过！
```

## 与其他系统集成

### 与 Task Management 配合

```python
# 任务描述中包含足够的上下文
TaskCreate(
    subject="实现用户认证",
    description="""
    基于第 10 轮讨论的架构设计：
    - 使用 JWT token
    - 存储在 Redis
    - 过期时间 24 小时
    
    相关文件: src/auth/jwt.py
    """
)

# 即使压缩了早期对话，任务描述仍然保留了关键信息
```

### 与 Memory 系统配合（未来）

```python
# 在压缩前，保存重要信息到 Memory
save_to_memory("用户偏好使用 TypeScript 而不是 JavaScript")
save_to_memory("数据库连接字符串在 .env 文件中")

# 压缩后，Memory 仍然可用
```

## 故障排查

### 问题：压缩后 Agent 忘记了重要信息

**症状**: Agent 询问之前已经讨论过的内容

**解决方案**:
1. 重新提供关键信息
2. 使用 Read 工具重新读取相关文件
3. 检查 Task 描述是否包含足够的上下文

### 问题：压缩过于频繁

**症状**: 每隔几轮就触发压缩

**解决方案**:
```python
# 提高阈值
compactor.threshold = 200_000

# 或减少保留轮数（不推荐）
compactor.preserved_turns = 8
```

### 问题：压缩不够频繁，仍然超限

**症状**: 即使有压缩，仍然遇到 token 限制错误

**解决方案**:
```python
# 降低阈值
compactor.threshold = 100_000

# 或减少保留轮数
compactor.preserved_turns = 5
```

## 总结

Auto-Compact 系统是支持长对话的关键功能：

- ✅ **自动化**: 无需手动干预
- ✅ **透明**: 通过边界消息告知 Agent
- ✅ **高效**: 节省 80-90% 的 tokens
- ✅ **简单**: 基于启发式规则，快速可靠

虽然当前实现较简单，但已经足以支持大多数长对话场景。未来的智能摘要功能将进一步提升效果。
