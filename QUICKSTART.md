# 快速启动指南

## 1. 配置 API Key

编辑 `config/settings.yaml`，填入你的 OpenRouter API Key：

```yaml
api:
  openrouter_api_key: "your-api-key-here"  # 替换为你的 API Key
```

获取 API Key: https://openrouter.ai/keys

## 2. 启动交互式终端

```bash
# 使用 uv 运行
uv run python -m ripple.cli.repl

# 或者直接运行（如果已激活虚拟环境）
python -m ripple.cli.repl
```

## 3. 使用终端

启动后，你可以：

- 直接输入问题或任务，Agent 会自动调用工具完成
- 使用 `/help` 查看帮助
- 使用 `/model <name>` 切换模型
- 使用 `/info` 查看当前配置
- 使用 `/exit` 退出

## 4. 示例任务

```
ripple> 创建一个文件 /tmp/hello.txt，内容是 Hello Ripple!

ripple> 读取 /tmp/hello.txt 的内容

ripple> 执行命令 ls -la /tmp/hello.txt
```

## 5. 查看可用工具

```bash
python list_tools.py
```

## 6. 单次命令模式

如果不需要交互式终端，可以使用单次命令模式：

```bash
uv run python -m ripple.cli.main "你的任务"
```

## 7. 创建自定义 Skill

在 `.claude/skills/` 目录下创建 `.md` 文件：

```markdown
---
name: my-skill
description: 我的自定义 Skill
arguments: [arg1, arg2]
allowed-tools:
  - Write
  - Bash
---

# My Skill

这是我的自定义 Skill，参数：$ARG1, $ARG2
```

## 故障排除

### 问题：找不到配置文件

确保 `config/settings.yaml` 存在于项目根目录。

### 问题：API Key 错误

检查 `config/settings.yaml` 中的 `api.openrouter_api_key` 是否正确。

### 问题：导入错误

运行 `uv sync` 重新安装依赖。
