---
name: podcast-auto-md
description: 用户在聊天里直接发送播客标题或链接时，自动走播客全链路：resolve -> extract -> content-resolve -> transcribe（必要时）-> summarize -> outline -> keywords，并产出一份完整 Markdown 文件返回给用户。
when-to-use: 用户给出播客标题或单集链接，希望直接拿到一份完整 markdown 归档
allowed-tools: [Skill, Bash, Read, Write]
---

# Podcast Auto MD

## 目的

当用户直接发送**一个播客标题或 URL** 时，自动完成整条播客处理链路，并生成一份可交付的 Markdown 文件。

> **用户只发一个播客标题 / URL → 系统自动生成完整播客 Markdown → 返回给用户。**

## 强触发场景

- 输入就是一个播客标题或 URL
- 用户说"帮我整理这期播客"
- 用户说"把这期播客生成 md 给我"
- 用户说"帮我输出完整播客内容"
- 用户说"总结一下这期播客"

## 输入

`$ARGUMENTS` 可以是：

```json
{ "title": "播客标题" }
```

或：

```json
{
  "title": "播客标题（可选，和 episode_url 至少给一个）",
  "episode_url": "https://www.xiaoyuzhoufm.com/episode/xxxx",
  "output_dir": "/workspace/outputs",
  "prefer_transcript": true,
  "include_full_transcript": true
}
```

## 执行步骤（必须按此执行）

### Step 1 — 判断起点

- 输入已是 URL（含 `xiaoyuzhoufm.com/episode/` 或 `podcasts.apple.com`）：**跳过 resolve**，直接 Step 3
- 否则（只有标题）：走 Step 2

### Step 2 — 调用 `podcast-episode-resolve`

```
Skill(skill="podcast-episode-resolve", args="<title 或 JSON>")
```

取 `best_match.episode_url`。若 `matched: false` → **立即停止**，返回候选给用户让他选。

### Step 3 — 调用 `podcast-episode-extract`

```
Skill(skill="podcast-episode-extract", args="{\"episode_url\": \"<url>\"}")
```

把返回的 `episode` 对象保存为 `meta`（后面所有 step 都要复用）。

### Step 4 — 调用 `podcast-episode-content-resolve`

传入 Step 3 的结果。根据 `strategy` 决定是否需要 Step 5：

- `text_only` / `prefer_text_then_audio`：跳到 Step 6
- `audio_only`：走 Step 5
- `none`：提前失败，参见"失败回退"

### Step 5 — 可选：`podcast-episode-transcribe`

```
Skill(skill="podcast-episode-transcribe", args="{\"audio_url\": \"<audio_url>\", \"episode_url\": \"<url>\"}")
```

- 成功：得到 `transcript.text` / `segments`
- `matched: false`（无 ASR）：继续用 shownotes 作为 `content`，Markdown 里标注"无 transcript"

### Step 6 — 汇总 content

把下面三者择优拼为 `content`（给后续 summarize/outline/keywords 用）：

- `meta.description`（节目简介）
- `meta.shownotes`（去 HTML 后的纯文本）
- `transcript.text`（若 Step 5 成功）

### Step 7 — 调用三个内容理解 skill

按顺序（彼此独立，也可并发）：

```
Skill(skill="podcast-episode-summarize", args="{\"title\": ..., \"content\": ...}")
Skill(skill="podcast-episode-outline",   args="{\"title\": ..., \"content\": ..., \"shownotes_outline\": <meta.outline>}")
Skill(skill="podcast-episode-keywords",  args="{\"title\": ..., \"content\": ...}")
```

### Step 8 — 组装 Markdown

1. 用 **Read** 工具读取同目录下的模板文件：`$SKILL_BASE_DIR/TEMPLATE.md`
2. 把模板中的 `{{title}}` / `{{podcast_name}}` / `{{guests}}` / `{{hosts}}` / `{{episode_url}}` / `{{resolve_info}}` / `{{source_provider}}` / `{{description}}` / `{{summary_short}}` / `{{summary_medium}}` / `{{summary_bullets}}` / `{{outline_sections}}` / `{{topics}}` / `{{entities}}` / `{{concepts}}` / `{{highlights}}` / `{{transcript}}` / `{{sources}}` / `{{notes}}` 全部替换为实际内容
3. 具体格式与降级要求严格遵循 `$SKILL_BASE_DIR/OUTPUT_SPEC.md`（尤其是 Outline 必须为"时间轴目录"样式）

### Step 9 — 写文件

```
output_dir = $ARGUMENTS.output_dir or "/workspace/outputs/podcast"
file_name  = <YYYY-MM-DD>-<slugified-title>.md    # 与 OUTPUT_SPEC.md 保持一致
```

用 **Bash** 先确保目录存在：

```bash
mkdir -p "<output_dir>"
```

再调用 **Write** 工具把 Markdown 写到 `<output_dir>/<file_name>`。

### Step 10 — 返回最终 JSON 给上层

## 输出 Schema

```json
{
  "matched": true,
  "title": "播客标题",
  "resolve": {
    "episode_url": "https://www.xiaoyuzhoufm.com/episode/xxxx",
    "source": "search:xiaoyuzhou",
    "confidence": 0.91
  },
  "markdown_path": "/workspace/outputs/xxx.md",
  "artifacts": {
    "summary": true,
    "outline": true,
    "keywords": true,
    "transcript": false
  },
  "notes": "无 ASR 环境，transcript 缺失；md 已基于 shownotes 生成"
}
```

## Outline 硬规则（与 `podcast-episode-outline` 一致）

- 有时间轴 → **直接用时间轴目录格式**：
  - `00:00:34 30年前的合影`
  - `00:02:12 四十周年巡演`
- **禁止**把时间轴 outline 渲染成 `### 1. ... / ### 2. ...` 这种纯文章目录
- 没有任何时间信息 → 明写"暂无时间轴"，**不要伪造 `00:00:00`**

## 产出硬规则

- Markdown 必须基于**结构化字段**组装，不是模型自由发挥的散文
- 结构稳定、易归档、含来源链接、明示 resolve 结果
- 区分"原始信息"（meta）和"模型生成信息"（summary/outline/keywords）
- 若只给了主题、没有真实 episode_url / transcript / shownotes：
  - **标记为"主题整理稿"**
  - **禁止输出伪造时间轴 outline**
  - 头部元信息中明写 `resolve.matched = false`

## 失败回退

| 场景 | 行为 |
|---|---|
| Step 2 resolve 失败 | 返回候选给用户，不生成 md |
| Step 3 extract 成功但 Step 5 transcribe 失败 | 生成精简版 md（无 transcript，其他字段齐全） |
| Step 5 transcribe 超时（> 10 min） | 先产出 metadata + summary + outline + keywords 版 md |
| 只有主题、没有真实 URL | 产出"主题整理稿"模式，`artifacts.outline = false` |

## 备注

这是一个**编排 skill**，不替代底层 skill，而是把 7~9 个子 skill 串成一个用户可直接感知的最终产物。每个 Step 中 `Skill(...)` 的调用都是真实调用，不能只在对话里"声明自己做了"。
