# Skill System

Ripple 的 Skill 系统允许你定义可重用的任务模板，类似于 claude-code 的 slash commands。

## 两种 Skill 类型

### 1. Bundled Skills（内置技能）

编译到 Ripple 中的技能，所有用户都可以使用。

**位置**: `src/ripple/skills/bundled/`

**示例**: `simplify.py`

```python
from ripple.skills.registry import register_bundled_skill

SIMPLIFY_PROMPT = """# Simplify: Code Review and Cleanup
Review all changed files for reuse, quality, and efficiency.
...
"""

def register_simplify_skill():
    register_bundled_skill(
        name="simplify",
        description="Review changed code for reuse, quality, and efficiency",
        content=SIMPLIFY_PROMPT,
        allowed_tools=["__all__"],  # 允许所有工具
        when_to_use="After making code changes",
    )
```

**注册**: 在 `src/ripple/skills/bundled/__init__.py` 中调用注册函数。

### 2. File-based Skills（文件技能）

用户定义的技能，存储为 Markdown 文件。

**位置**: `skills/` 目录

**格式**: Markdown 文件，带 YAML frontmatter

**示例**: `skills/hello.md`

```markdown
---
name: hello
description: A simple hello world skill
arguments: [name]
allowed-tools: [Bash, Read]
context: inline
---

# Hello Skill

Hello, $NAME! Welcome to Ripple.

The current arguments are: $ARGUMENTS
```

## Frontmatter 字段

- `name`: 技能名称（可选，默认使用文件名）
- `description`: 技能描述
- `arguments`: 参数列表（用于 `$ARG` 替换）
- `allowed-tools`: 允许的工具列表，或 `all` 表示所有工具
- `context`: 执行上下文
  - `inline`（默认）: 在当前对话中执行
  - `fork`: 在独立的子代理中执行
- `when-to-use`: 使用场景说明
- `model`: 模型覆盖（可选）
- `hooks`: Hook 配置（可选）

## 参数替换

在 skill 内容中可以使用以下占位符：

- `$ARGUMENTS`: 所有参数的原始字符串
- `$NAME`, `$ARG1`, `$ARG2`: 具名参数（需要在 frontmatter 中定义）

## 执行模式

### Inline 模式（默认）

Skill 内容直接注入到当前对话流中，模型会看到 skill 的内容并执行。

```yaml
context: inline
```

### Fork 模式

在独立的子代理中执行 skill，适合复杂的多步骤任务。

```yaml
context: fork
```

Fork 模式会：
1. 创建新的 agent session
2. 在后台运行
3. 将结果写入 `.ripple/tasks/` 目录
4. 返回任务通知

## 使用 Skills

在 CLI 中使用 Skill tool：

```
使用 Skill tool 执行 simplify skill
```

或者通过 API：

```python
from ripple.skills.loader import get_global_loader

loader = get_global_loader()
skill = loader.get_skill("simplify")
```

## 加载顺序

1. **Bundled skills** - 内置技能
2. **File-based skills** - 用户技能（可以覆盖 bundled skills）

## 创建新的 Bundled Skill

1. 在 `src/ripple/skills/bundled/` 创建新文件（如 `my_skill.py`）
2. 定义 prompt 常量和注册函数
3. 在 `__init__.py` 中导入并调用注册函数
4. 运行测试验证

## 创建新的 File-based Skill

1. 在 `skills/` 目录创建 `.md` 文件
2. 添加 YAML frontmatter
3. 编写 skill 内容
4. 重启 CLI 或重新加载

## 示例

查看现有的 skills：

```bash
uv run python scripts/list_tools.py
```

运行测试：

```bash
uv run python tests/test_skills.py
uv run python tests/test_fork_mode.py
```
