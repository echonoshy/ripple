---
name: podcast-episode-outline
description: 根据播客内容生成带时间锚点的结构化大纲，用于章节浏览、跳转回听、UI section 展示。
when-to-use: 需要生成章节目录、时间轴大纲，或为后续跳转/UI 展示提供 section 列表
---

# podcast-episode-outline

## 目的

产出**带时间锚点**的结构化大纲，展示本期是如何展开的，并为跳转、回听、UI 章节提供 section 列表。

纯模型处理 skill，不需要外部工具。

## 输入

`$ARGUMENTS` 为 JSON：

```json
{
  "title": "播客标题（可选）",
  "podcast_name": "节目名（可选）",
  "content": "transcript（含时间戳最佳）或节目正文",
  "shownotes_outline": [ { "timestamp": "00:02:12", "seconds": 132, "topic": "..." } ],
  "max_sections": 12,
  "window": { "start": 0, "end": 3600 }
}
```

## 执行步骤（必须按此执行）

### Step 1 — 判断时间信息来源（按优先级）

1. **`shownotes_outline`**（来自 `podcast-episode-extract`）：**一旦有就必须原样采用**，不要重新生成时间
2. **`content` 中的 transcript.segments**（含 `start/end` 秒数）：做话题聚类，边界落在段间
3. **什么时间都没有**：`sections: []` + `notes: "暂无时间轴"`，**严禁伪造**

### Step 2 — 聚合 sections

- 若来自 Step 1.1：按原 outline 直接映射，`index` 从 1 递增
- 若来自 Step 1.2：用话题切换点作 section 边界，每段 ≥ 90 秒
- 总数上限 = `max_sections`（默认 12）

### Step 3 — 填 summary

`sections[i].summary` 每段 **一句话**（≤ 40 字），只陈述本段做了什么，不要总结全局。避免和 `podcast-episode-summarize` 职能重叠。

### Step 4 — 时间字段规则

- `timestamp`：`HH:MM:SS` 格式字符串（必填）
- `start`：秒数（必填）
- `end`：秒数（有下一个 section 时 = 下一个的 `start`；最后一段 = 本期总时长或 `window.end`；拿不到就省略）

### Step 5 — 输出

## 输出 Schema

```json
{
  "matched": true,
  "outline": {
    "title": "本期主线",
    "sections": [
      {
        "index": 1,
        "timestamp": "00:00:34",
        "title": "30 年前的合影",
        "summary": "开场引出两人早期合影的故事",
        "start": 34,
        "end": 132
      }
    ]
  },
  "scope": { "mode": "full_episode", "start": 0, "end": 3600 },
  "notes": "若完全没有时间信息，应明确写 '暂无时间轴'，不得伪造时间"
}
```

## 硬规则（再次强调）

- **没时间就空 sections + 写 notes**，宁可空也不伪造 `00:00:00` 占位。
- 有 `shownotes_outline` 时，**按原 timestamp 原样输出**，不要四舍五入或重算。
- `sections` 必须按 `start` 升序排列。
