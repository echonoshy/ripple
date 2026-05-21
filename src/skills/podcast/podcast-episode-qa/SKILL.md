---
name: podcast-episode-qa
description: 基于单期播客内容（文本 / transcript / 局部上下文）回答与本期相关的具体问题。支持从 work_dir 读现成 content.txt / transcript.json。
when-to-use: 用户问"这期嘉宾是谁""刚才讲了什么""xxx 是什么意思""主持人的结论是什么"这类与单期内容相关的问题
allowed-tools: [Read]
---

# podcast-episode-qa

## 目的

内容理解层**最直接面向交互**的 skill：基于单期播客上下文回答用户的具体问题。

纯模型处理 skill。

## 输入

`$ARGUMENTS` 为 JSON，支持两种模式：

### 模式 A — 流水线模式（已跑过 podcast-auto-md）

```json
{
  "question": "用户的问题（必填）",
  "work_dir": "/workspace/.podcast-work/<episode_id>",
  "answer_style": "concise | explain | quote"
}
```

用 `Read` 从 `work_dir` 取内容：
1. 优先读 `<work_dir>/transcript.json` 的 `transcript.text` / `segments`
2. 否则读 `<work_dir>/content.txt`
3. 可选读 `<work_dir>/meta.json` 取 `title` / `podcast_name` 作为问答语境

### 模式 B — 直接传文本

```json
{
  "question": "用户的问题（必填）",
  "content": "transcript / 节目正文（必填）",
  "title": "播客标题（可选）",
  "podcast_name": "节目名（可选）",
  "window": { "start": 120, "end": 360 },
  "answer_style": "concise | explain | quote"
}
```

## 执行步骤（必须按此执行）

### Step 1 — 校验输入

- 模式 A：`work_dir` 必须指向已存在的目录，且至少有 `content.txt` 或 `transcript.json`
- 模式 B：`question` 或 `content` 缺失
- 任意校验失败：返回 `matched: false` + `notes`

### Step 2 — 在 `content` 中定位证据

- 若给了 `window`：只在该区间内找证据，`scope.mode = "window"`
- 否则全片查找，`scope.mode = "full_episode"`
- 命中 1~3 段最相关片段作为 evidence

### Step 3 — 按 answer_style 组织回答

| style | 长度 | 要求 |
|---|---|---|
| `concise`（默认） | ≤ 100 字 | 直接给结论，必要时补一句佐证 |
| `explain` | 200~400 字 | 用 content 里的论据说清"为什么" |
| `quote` | 引用原句 + 简注 | 引用必须是 `content` 的真实片段，不得改写 |

### Step 4 — 给 confidence

| 情况 | confidence |
|---|---|
| `content` 中有明确原文答案 | `high` |
| 靠 `content` 合理推断得出 | `medium` |
| 只能旁证或不足以回答 | `low`（必须在 notes 里说明） |

### Step 5 — 输出

## 输出 Schema

```json
{
  "matched": true,
  "answer": {
    "text": "回答正文",
    "type": "factual | opinion | explanation | quote",
    "confidence": "high | medium | low"
  },
  "scope": { "mode": "window", "start": 120, "end": 360 },
  "evidence": [
    { "text": "原文片段", "start": 145, "end": 168 }
  ],
  "notes": "信息不足时必须说明"
}
```

## 硬规则

- **信息不足时必须降级**：返回 `confidence: low` + `notes`，**绝不编造**。
- `answer_style = quote` 时，`answer.text` 必须是 `content` 里逐字片段（允许省略号，不允许改写）。
- `scope.mode = window` 时，`start / end` 必须一起给出。
