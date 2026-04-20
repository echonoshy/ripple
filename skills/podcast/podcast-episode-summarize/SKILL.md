---
name: podcast-episode-summarize
description: 根据播客的 transcript / 节目介绍 / 文本内容，生成三粒度摘要（一句话 / 段落 / 要点），供后续 QA、关键词、outline 建立上层理解。支持把结果直接落盘到 work_dir/summary.json。
when-to-use: 用户说"这期讲了什么""帮我总结""快速回顾""刚才那段讲啥"等意图，或 podcast-auto-md 流水线调用
allowed-tools: [Read, Write]
---

# podcast-episode-summarize

## 目的

内容理解层的基础 skill：**先把内容压缩清楚**，后续 QA、关键词、outline 都建立在它之上。

这是一个**模型处理 skill**，可以使用 `Read` 读取 work_dir 中的 content.txt，并用 `Write` 把结果落盘到 `work_dir/summary.json`。输入文本来自上游（extract / content-resolve / transcribe）。

## 输入

`$ARGUMENTS` 为 JSON。推荐的流水线模式（由 `podcast-auto-md` 调用）：

```json
{
  "work_dir": "/workspace/.podcast-work/<episode_id>",
  "style": "neutral",
  "max_points": 5
}
```

当给了 `work_dir` 时，**必须**：
1. 用 `Read` 工具读取 `<work_dir>/content.txt` 作为 `content`
2. 若存在 `<work_dir>/meta.json`，从中取 `episode.title` / `episode.podcast_name`
3. 在 Step 5 里用 `Write` 把完整 JSON 写到 `<work_dir>/summary.json`
4. 只给调用方返回一行确认，**不要**把完整 JSON 贴回对话

也支持独立使用模式（不走流水线）：

```json
{
  "title": "播客标题（可选）",
  "podcast_name": "节目名（可选）",
  "content": "transcript 或节目正文文本（必填）",
  "style": "neutral | casual | crisp",
  "max_points": 5,
  "window": { "start": 120, "end": 360 }
}
```

此时无 `work_dir`，直接返回 JSON 给调用方。

## 执行步骤（必须按此执行）

### Step 1 — 校验输入

`content` 为空或 `< 200` 字：直接返回 `matched: false` + `notes: "输入文本不足以生成摘要"`，不要硬写。如果是流水线模式，也要把这个错误对象写入 `summary.json`，方便 render.py 做降级。

### Step 2 — 确定 scope

- 给了 `window`：`scope.mode = "window"`，复写 `start/end`
- 未给：`scope.mode = "full_episode"`，`start = 0`

### Step 3 — 按 style 生成三粒度摘要

| 粒度 | 长度上限 | 要求 |
|---|---|---|
| `short` | 1 句、≤ 60 字 | 一句话讲清主题 + 节目视角 |
| `medium` | 1~2 段、≤ 300 字 | 覆盖主要脉络（按原文展开顺序） |
| `bullet_points` | `max_points` 条（默认 5，范围 3~7） | 每条 ≤ 30 字，**覆盖原文各大段**而不是同一点多述 |

style 影响语气：
- `neutral`（默认）：客观描述
- `casual`：口语化、带点语气词
- `crisp`：短句、名词化、信息密度高

### Step 4 — 事实性守则

- **只用 `content` 里真实出现过的信息**。
- 数字、人名、机构、时间必须与 `content` 对齐；不确定就用模糊说法（"多家机构"）。
- 不要替作者下没说过的结论。

### Step 5 — 输出

严格按下方 Schema 产出 JSON。

**流水线模式（给了 `work_dir`）**：
1. 用 `Write` 工具把这份 JSON 写到 `<work_dir>/summary.json`
2. 给调用方返回一行短确认，例如：
   ```
   summary.json 已写入 /workspace/.podcast-work/<eid>/summary.json（bullet=5, mode=full_episode）
   ```
3. **不要**把完整 JSON 内容贴回对话——这会显著增大后续 turn 的上下文并导致流式超时。

**独立模式（未给 `work_dir`）**：直接把 JSON 作为最终回复返回。

## 输出 Schema

```json
{
  "matched": true,
  "summary": {
    "short": "一句话摘要",
    "medium": "一两段的段落摘要",
    "bullet_points": ["要点 1", "要点 2", "要点 3"]
  },
  "scope": { "mode": "full_episode", "start": 0, "end": 3600 },
  "notes": "bullet 数量 3~7 条"
}
```

## 硬规则

- bullet 条数：**3 ≤ n ≤ 7**，且每条语义不重复。
- 不加节目里没有的外部知识或推测。
- `short` 必须是完整句，不要只给名词短语。
