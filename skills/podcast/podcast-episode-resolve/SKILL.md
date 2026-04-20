---
name: podcast-episode-resolve
description: 根据用户提供的播客标题，找到最可能对应的 episode URL，供后续 extract / content-resolve 等 skill 使用。只负责找页面，不做正文抽取。
when-to-use: 用户只给出播客标题（或"帮我找这期播客""这期链接是什么"这类意图），且后续链路需要一个 episode URL 才能继续
allowed-tools: [Search, Bash]
---

# podcast-episode-resolve

## 目的

**播客标题 → 最可能的 episode URL。** 标题解析层的第一段：只 resolve，不抽取正文、嘉宾、章节。

## 输入

`$ARGUMENTS` 可以是：
- 裸标题字符串："Anthropic、Palantir与Citrini：谁在操控伊朗战争？"
- JSON：`{ "title": "...", "podcast_name": "...(可选)", "author": "...(可选)" }`

## 执行步骤（必须按此执行）

### Step 1 — 解析输入

提取 `title`、`podcast_name`（可选）、`author`（可选）。

### Step 2 — 构造 3 条平台偏好查询

按中文播客场景偏好，**并发**跑下列 3 个查询（平台偏好：小宇宙 > Apple Podcasts > 其他）：

1. `<title> site:xiaoyuzhoufm.com`
2. `<title> site:podcasts.apple.com`
3. `<title> <podcast_name?> <author?>`（通用召回）

每条查询调用 **Search** 工具：

```
Search(query="<title> site:xiaoyuzhoufm.com", max_results=5)
Search(query="<title> site:podcasts.apple.com", max_results=5)
Search(query="<title> <podcast_name?>", max_results=5)
```

### Step 3 — 归并并打分

对所有候选结果计算 `confidence`：

| 信号 | 分数贡献 |
|---|---|
| URL host 命中小宇宙 episode 页 (`/episode/<id>`) | +0.40 |
| URL host 命中 Apple Podcasts 单集页 (含 `?i=`) | +0.30 |
| 结果标题与 `title` 高度相似（子串/全匹配） | +0.30 |
| 结果正文提及 `podcast_name` 或 `author` | +0.15 |
| 聚合页 / 分类页 / 主页 | −0.30 |

### Step 4 — 可选：二次确认

若 top1 置信度仍 `< 0.55`，再跑一次 `Search("<title>" 逐字引号)` 缩小召回。

### Step 5 — 置信度分档输出

- `confidence ≥ 0.80`：填 `best_match`，`candidates` 可空
- `0.55 ≤ confidence < 0.80`：填 `best_match` + top3 `candidates`
- `confidence < 0.55`：`matched: false`，只返回 `candidates`，由上层确认

## 输出 Schema

```json
{
  "matched": true,
  "confidence": 0.91,
  "query": { "title": "播客标题" },
  "best_match": {
    "title": "本期标题",
    "podcast_name": "播客节目名",
    "episode_url": "https://www.xiaoyuzhoufm.com/episode/xxxx",
    "source": "search:xiaoyuzhou"
  },
  "candidates": [
    {
      "title": "候选标题",
      "podcast_name": "候选播客名",
      "episode_url": "https://podcasts.apple.com/...?i=xxx",
      "source": "search:apple-podcasts",
      "confidence": 0.72
    }
  ],
  "notes": "低置信度时返回多个候选，不强判"
}
```

## 硬规则

- **不凭空拼 URL**：只使用 Search 返回的真实 href。
- **不强判**：`confidence < 0.55` 必须 `matched: false`。
- `source` 写清楚是哪条查询命中的（`search:xiaoyuzhou` / `search:apple-podcasts` / `search:general`）。
