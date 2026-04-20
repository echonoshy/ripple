---
name: podcast-episode-content-resolve
description: 根据播客标题、episode URL 或已有元信息，选出可用的内容来源并确定获取策略。只做路由决策，不做总结也不做转写。
when-to-use: 上游已有 episode 元信息，但还没有正文/transcript，需要决定"内容从哪里拿最划算"时
---

# podcast-episode-content-resolve

## 目的

内容获取层的**路由 skill**。只回答一个问题：

> 这期播客的内容，应该从哪里拿最划算？

**不直接总结，也不直接转写；只给路由决策。**

## 输入

`$ARGUMENTS` 为上游 `podcast-episode-extract` 的输出（或其子集）：

```json
{
  "episode_url": "https://example.com/episode/123",
  "title": "播客标题",
  "podcast_name": "节目名",
  "description": "已有节目介绍",
  "shownotes": "<html shownotes>",
  "audio_url": "https://cdn.example.com/audio.mp3",
  "outline": [ { "timestamp": "00:02:12", "topic": "..." } ]
}
```

## 执行步骤（必须按此执行）

### Step 1 — 计算可用文本总量

```
text_chars = len(description) + len(strip_html(shownotes))
```

### Step 2 — 按下表决策 strategy

| 条件 | strategy | best_source |
|---|---|---|
| `text_chars ≥ 2000` 且 `outline` 非空 | `text_only` | `{ type: "shownotes_page", quality: "high" }` |
| `1000 ≤ text_chars < 2000` | `prefer_text_then_audio` | `{ type: "shownotes_page", quality: "medium" }` |
| `text_chars < 1000` 且存在 `audio_url` | `audio_only` | `{ type: "audio_file", quality: "fallback" }` |
| 无文本、无音频 | `none` | `null` （`matched: false`） |

### Step 3 — 填 content_sources 列表

按优先级列全部可用源（即使当前不选，也留给上层备选）：

1. `shownotes_page` — 用上游已拿到的 `description + shownotes`
2. `transcript_page` — 若 `episode_url` 页面单独挂了文字稿（通常无）
3. `audio_file` — 回退用，`url = audio_url`

### Step 4 — 输出

## 输出 Schema

```json
{
  "matched": true,
  "strategy": "prefer_text_then_audio",
  "text_chars": 1860,
  "best_source": {
    "type": "shownotes_page",
    "url": "https://example.com/episode/123",
    "quality": "medium"
  },
  "content_sources": [
    {
      "type": "shownotes_page",
      "url": "https://example.com/episode/123",
      "quality": "medium",
      "notes": "description + shownotes 合计 1860 字，略显精简"
    },
    {
      "type": "audio_file",
      "url": "https://cdn.example.com/audio.mp3",
      "quality": "fallback",
      "notes": "文本不足时可转写"
    }
  ],
  "notes": "优先使用现成文本，音频转写作为兜底"
}
```

## 硬规则

- **绝不臆造 transcript_page**：除非输入里确实出现了独立文字稿链接。
- 没有 `audio_url` 时不要把 `audio_file` 塞进 `content_sources`。
- `strategy` 字段只能是 `text_only` / `prefer_text_then_audio` / `audio_only` / `none` 四选一。
