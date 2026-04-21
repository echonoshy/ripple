---
name: podcast-auto-md
description: 用户给一个播客 URL 或标题，直接产出一份完整 Markdown：在对话里完整呈现，同时落盘到 host 可见路径。无 JSON 切片、无渲染脚本、无中间产物。
when-to-use: 用户发送一个播客标题或单集链接，希望直接拿到 Markdown
allowed-tools: [Skill, Bash, Write, Read]
---

# Podcast Auto MD

## 目的

> 用户只发一个播客 URL / 标题 → 你产出一份完整 Markdown → 同时**在对话里展示给用户** + **落盘到指定路径**。

## 触发场景

- 输入是播客标题或 URL
- "帮我整理这期播客 / 生成 md / 总结一下"

## 输入

`$ARGUMENTS` 可以是：
- 裸 URL：`https://www.xiaoyuzhoufm.com/episode/xxxx`
- 裸标题：`某期标题`
- JSON：`{"episode_url": "...", "title": "...", "output_dir": "..."}`

## 流程（仅 2~3 步，不要画蛇添足）

### Step 0 — 仅当只有标题、没 URL 时：先 resolve

```
Skill(skill="podcast-episode-resolve", args="{\"title\": \"<title>\"}")
```

- 若 `matched: false`：直接返回候选给用户挑，**不**继续后面步骤
- 若 `matched: true`：用 `best_match.episode_url` 进入 Step 1

### Step 1 — 用 pipeline.py 一键抓取

```bash
python3 /home/lake/workspace/wip/ripple-dev/skills/podcast/podcast-auto-md/pipeline.py prepare \
  --args '{"episode_url": "<url>"}'
```

输出一行 JSON，关键字段：

| 字段 | 说明 |
|---|---|
| `work_dir` | `/workspace/.podcast-work/<eid>/`，含 `meta.json` + `content.txt` |
| `output_path` | **最终 md 落盘路径**，默认 `/workspace/.outputs/podcast/YYYY-MM-DD-<slug>.md`（从宿主看即 `<repo>/.ripple/sandboxes/<uid>/workspace/.outputs/podcast/...`） |
| `title` / `podcast_name` / `audio_url` / `has_outline` / `outline_sections` | 元信息摘要 |

> **不要再调用 `podcast-episode-extract` / `understand` / `transcribe` / `render.py`**——这些步骤都被 pipeline.py 一次完成或已被废弃。

### Step 2 — 读原料 + 直接写 Markdown + 同时落盘 + 同时呈现

1. **Read** `<work_dir>/meta.json` 和 `<work_dir>/content.txt` 拿原料
2. **按下面的"模板与硬规则"在对话里直接写出完整 Markdown**
3. 在**同一条**回复里**用 `Write` 工具**把这段 Markdown 落盘到 `output_path`
4. 在**同一条**回复里**也**把 Markdown 完整文本呈现在对话正文中（用户的明确要求）

> 关键：**Markdown 写一次，既给用户看、也给 Write 工具用**——同样的内容、同步落盘。**不要让模型生成任何 JSON 文件**。

### Step 3 — 末尾用一行说明确认

`已生成: <output_path>（约 N 字、M 个章节）`

## 模板与硬规则（直接照抄）

```markdown
# {{episode.title}}

- **播客**：{{episode.podcast_name}}
- **主播**：{{episode.hosts | join("、") | "_未标注_"}}
- **嘉宾**：{{episode.guests | join("、") | "_未标注_"}}
- **发布日期**：{{episode.published_at | YYYY-MM-DD}}
- **时长**：{{episode.duration | "X 小时 Y 分钟" 或 "M 分钟"}}
- **链接**：{{episode.episode_url}}

## 节目简介

{{节目简介，控制在 ~400 字内；如果原 description 是 shownotes 头部的复述，则截取主要 1~3 段即可，可在末尾用「……」表示折叠}}

## 摘要

**一句话**：{{≤ 60 字的本期最浓缩定位}}

{{1~2 段、≤ 300 字的中等长度摘要，覆盖主线脉络。中文双引号统一用「」/『』，**不要用半角 `"`**。}}

### 要点

- {{要点 1，≤ 30 字}}
- {{要点 2}}
- {{...3~7 条，覆盖原文各大段不重复}}

## 时间轴

> 时间戳必须**全部**直接复用 `meta.episode.outline` 字段（pipeline 已抓好）。**禁止伪造或重新估算时间**。

- {{HH:MM:SS}}  {{原 topic}}{{ —— 可选的一句解读，≤ 40 字}}
- ...

## 关键词

- **主题**：{{topic1}} · {{topic2}} · {{topic3}}
- **实体**：{{entity1}} · {{entity2}} · ...
- **核心概念**：{{concept1}} · {{concept2}} · ...

### 值得追问

- **{{高价值切入点 1}}** — {{为什么值得追问，一句话}}
- ...3~6 条

## 相关链接

- 原始链接：{{episode.episode_url}}
- 音频：{{episode.audio_url}}
- {{shownotes 里出现的参考资料链接，如果有}}

---

<sub>由 podcast-auto-md 自动整理。数据来源：{{source.provider}}。</sub>
```

### 内容硬规则

- 所有人名 / 数字 / 机构 / 引述都必须能在 `content.txt` 里找到出处，**不引入节目外的知识**
- 字符串中如果想表达"引号"，统一用 `「」` / `『』`，**不要写半角 `"`**（避免任何潜在的转义陷阱）
- 时间轴**直接复用** `meta.episode.outline`，按 `seconds` 升序排列
- 如果 outline 为空：写 `_（本期无原始时间轴）_`，**不要伪造 `00:00:00` 占位**
- description 段控制在 ~400 字内，超长就截断 + `……`
- 如果 hosts / guests / duration 缺失：用 `_未标注_` 占位
- Markdown 不要超过 3 级标题（`###`）
- 不要在 md 里出现"由模型生成"以外的任何元注释（不要 `<details>`、不要调试信息）

## 输出 Schema（你最终在对话里返回给上层的内容）

整个回复结构：

1. **完整 Markdown 文本**（用户要看的产物）
2. 一行确认：`已生成: <output_path>（X 字 / Y 个章节）`

不需要返回 JSON。上层 caller 直接用 `output_path` 作为 artifact。

## 失败回退

| 场景 | 行为 |
|---|---|
| Step 0 resolve 失败 | 把候选交给用户，**不**生成 md |
| Step 1 prepare 抓页面失败（fetched=false） | 仍然产出一份"信息不全"版 md：保留链接 + 简单说明，不编造内容 |
| 只给 title、resolve 也失败 | 不产出 md，直接告诉用户 |

## 禁用项（曾是故障根因，绝对不要做）

- ❌ 不要生成任何 `summary.json` / `outline.json` / `keywords.json` / `understand_input.json`
- ❌ 不要再调用 `podcast-episode-understand`、`podcast-auto-md/render.py`、`pipeline.py split-understand` —— 它们已经被删除
- ❌ 不要在 markdown 字符串里使用半角双引号 `"`，统一用 `「」` / `『』`
- ❌ 不要用 `TaskCreate` / `TaskUpdate`
- ❌ 不要在调完 pipeline 之后又用 `cat` / `Read` 重复读 `meta.json`、`content.txt`——一次就够
- ❌ 不要把 markdown 写成"先调 Write 落盘，然后说'内容如下'再贴一次"的两步——**在同一条回复里**，对话正文 = Write 的内容，逻辑上只有一份
