<div align="center">

<img src="assets/icon.png" alt="Ripple Logo" width="120" />

# Ripple 涟漪

*让每个提问都成为涟漪的中心，每一次循环都是向解的蔓延。*

[![Python 3.13+](https://img.shields.io/badge/Python-3.13%2B-blue?style=for-the-badge&logo=python&logoColor=white)](https://www.python.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)
[![Status: Beta](https://img.shields.io/badge/Status-Beta-orange?style=for-the-badge)](https://github.com/echonoshy/ripple)

**Ripple** 是一个基于 Python 的 Agent 系统，灵感源自 [claude-code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview)。

完整的 Agentic Loop · 强大的工具调用 · 灵活的 Skill 系统

</div>

---

## 演示

### CLI 界面

<p align="center">
  <img src="assets/cli-1.png" width="100%" alt="Ripple CLI 界面与信息搜索演示" />
</p>

<p align="center">
  <img src="assets/cli-2.png" width="100%" alt="Ripple Skill 系统调用演示" />
</p>

### Web 界面

<p align="center">
  <img src="assets/web-1.png" width="100%" alt="Ripple Web 界面" />
</p>

## 快速开始

```bash
# 克隆仓库
git clone https://github.com/echonoshy/ripple.git
cd ripple

# 安装依赖
uv sync

# 配置 API Key (编辑 config/settings.yaml)
api:
  api_key: "your-api-key-here"
  base_url: "https://openrouter.ai/api/v1"

# 启动
uv run ripple cli
```

## 文档

详细文档正在完善中，敬请期待...

- 使用指南
- Skill 开发
- 工具扩展
- API 参考

## 开源协议

本项目基于 [MIT License](https://opensource.org/licenses/MIT) 开源。

---

<div align="center">
<sub>Built with ❤️ by echonoshy</sub>
</div>
