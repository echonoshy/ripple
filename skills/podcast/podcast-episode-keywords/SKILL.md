---
name: podcast-episode-keywords
description: 从播客内容中提取 topics / entities / concepts / highlights，为标签、检索、QA 入口、概念解释提供结构化基础。支持把结果直接落盘到 work_dir/keywords.json。
when-to-use: 需要生成关键词卡片、提取概念标签、找出可追问的概念，或 podcast-auto-md 流水线调用
allowed-tools: [Read, Write]
---

# podcast-episode-keywords

## 目的

从文本 / transcript 中提取：

- **主题（topics）**：文章级的话题，粒度大，偏抽象（例："AI 创业"）
- **实体（entities）**：具名对象，NER 粒度（例："OpenAI"、"GPT-5"、"彼得·蒂尔"）
- **核心概念（concepts）**：需要解释的术语 / 方法论（例："RAG"、"Agentic Workflow"）
- **值得追问的亮点（highlights）**：有非平凡信息量，值得继续问的高价值项

支持 `Read` / `Write`：在流水线模式下从 work_dir 读取输入、把结果写入 `<work_dir>/keywords.json`。

## 输入

`$ARGUMENTS` 为 JSON。推荐的流水线模式（由 `podcast-auto-md` 调用）：

```json
{
  "work_dir": "/workspace/.podcast-work/<episode_id>",
  "max_keywords": 20
}
```

当给了 `work_dir` 时，**必须**：
1. 用 `Read` 读 `<work_dir>/content.txt` 作为 `content`，读 `<work_dir>/meta.json` 取 `episode.title` / `episode.podcast_name`
2. 在 Step 4 里用 `Write` 把完整 JSON 写到 `<work_dir>/keywords.json`
3. 只给调用方返回一行确认，**不要**把完整 JSON 贴回对话

独立模式：

```json
{
  "title": "播客标题（可选）",
  "podcast_name": "节目名（可选）",
  "content": "transcript 或节目正文（必填）",
  "max_keywords": 20,
  "window": { "start": 0, "end": 3600 }
}
```

## 执行步骤（必须按此执行）

### Step 1 — 扫描 `content`，做分类登记

逐段读 `content`，把出现的信息按四象限登记：

- 粒度由大到小：topics → concepts → entities
- 已出现 ≥ 2 次或有明显解释段落 → candidate for `concepts` / `highlights`

### Step 2 — 去重与去混淆

- `topics`：不与 `concepts` 重复；若 `AI 大模型` 同时像主题又像概念，归到 `topics`
- `entities`：必须是专有名词；"公司"、"政府"这种通用词不收
- `concepts`：必须是**需要额外解释**的术语，普通词不收
- 三者总和 ≤ `max_keywords`（默认 20）

### Step 3 — 生成 highlights

- 每条 `highlight` 必须能**引出下一轮对话**。
- `reason` 解释为什么值得追问（而不是复述 term 本身的字面意思）。
- 数量 3~8 条。

### Step 4 — 输出

**流水线模式（给了 `work_dir`）**：
1. 用 `Write` 把 JSON 写到 `<work_dir>/keywords.json`
2. 给调用方返回一行短确认，例如：`keywords.json 已写入 ...（topics=5, entities=12, concepts=4, highlights=6）`
3. **不要**把完整 JSON 贴回对话

**独立模式**：直接把 JSON 作为最终回复返回。

## 输出 Schema

```json
{
  "matched": true,
  "keywords": {
    "topics": ["AI 创业", "大模型商业化"],
    "entities": ["OpenAI", "GPT-5"],
    "concepts": ["RAG", "Agentic Workflow"],
    "highlights": [
      {
        "term": "Agentic Workflow",
        "reason": "嘉宾用来解释为什么 agent 比单轮 LLM 更能落地业务，值得进一步追问"
      }
    ]
  },
  "scope": { "mode": "full_episode" },
  "notes": ""
}
```

## 硬规则

- `highlights` 必须是"**可继续追问的高价值项**"，不是词频统计。
- `topics` / `entities` / `concepts` **三者语义不能重复**（主题 vs 具体命名 vs 抽象概念）。
- 所有 term 必须在 `content` 中真实出现（允许模型规范化大小写 / 简繁，但不允许凭空发明）。
