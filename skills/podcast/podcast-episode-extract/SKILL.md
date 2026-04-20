---
name: podcast-episode-extract
description: 根据已知的 episode URL，抽取该期播客的结构化元信息（标题、节目名、简介、嘉宾、主播、章节 outline 等）。不负责搜索 URL。支持把结果落盘到 work_dir/meta.json 和 content.txt。
when-to-use: 用户提供了播客单集链接，或上游 skill 已经拿到 episode_url 需要取元信息时
allowed-tools: [Bash, Write]
---

# podcast-episode-extract

## 目的

**episode URL → 结构化元信息。** 标题解析层的第二段：只 extract，不 resolve。

## 输入

`$ARGUMENTS` 既可是一个裸 URL 字符串，也可是 JSON：

```json
{
  "episode_url": "https://www.xiaoyuzhoufm.com/episode/69cdbe5eb977fb2c47e1e409",
  "work_dir": "/workspace/.podcast-work/<episode_id>"
}
```

若给了 `work_dir`（流水线模式），**必须**在完成 extract 后：
1. 用 `Write` 把本 skill 的完整 JSON（符合下节 Schema）写到 `<work_dir>/meta.json`
2. 再用 `Write` 把 `description + 去 HTML 的 shownotes` 拼接后的纯文本写到 `<work_dir>/content.txt`（供 summarize / outline / keywords 复用，避免重复抓取/清洗）
3. 只给调用方返回一行短确认，**不要**把完整 JSON 贴回对话

若没给 `work_dir`，按原样把 JSON 作为最终回复返回。

## 执行步骤（必须按此执行）

### Step 1 — 解析输入

把 `$ARGUMENTS` 解析为 `episode_url`：
- 如果是合法 URL，直接用
- 如果是 JSON，取 `episode_url` 字段
- URL 清洗：保留 path，去掉 `?utm_source=...` 这类跟踪参数

### Step 2 — 识别平台

依据 host 选抽取策略：

| host | provider | 抽取方式 |
|---|---|---|
| `xiaoyuzhoufm.com` | `xiaoyuzhou` | `__NEXT_DATA__` 内嵌 JSON |
| `podcasts.apple.com` | `apple-podcasts` | `<meta>` + JSON-LD |
| 其他 | `page-extract` | `og:*` meta + 正文启发式 |

### Step 3 — 抓页面并抽 JSON（小宇宙示例）

调用 **Bash** 工具：

```bash
curl -sL "<episode_url>" \
  -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" \
  -H "Accept-Language: zh-CN,zh;q=0.9" \
  | python3 -c "
import sys, re, json
html = sys.stdin.read()
m = re.search(r'<script id=\"__NEXT_DATA__\" type=\"application/json\">(.*?)</script>', html, re.DOTALL)
if not m:
    print(json.dumps({'error': 'no __NEXT_DATA__'})); sys.exit(0)
data = json.loads(m.group(1))
ep = data.get('props', {}).get('pageProps', {}).get('episode', {})
pod = ep.get('podcast', {}) or {}
print(json.dumps({
  'title': ep.get('title'),
  'description': ep.get('description'),
  'shownotes': ep.get('shownotes'),
  'podcast_name': pod.get('title'),
  'podcast_author': pod.get('author'),
  'podcast_description': pod.get('description'),
  'published_at': ep.get('pubDate'),
  'duration': ep.get('duration'),
  'audio_url': (ep.get('enclosure') or {}).get('url') or ep.get('mediaKey'),
  'eid': ep.get('eid'),
}, ensure_ascii=False))
"
```

### Step 4 — 解析 shownotes 时间轴

小宇宙 shownotes 里的时间轴以 `<a class=\"timestamp\" data-timestamp=\"158\">02:38</a> 话题` 出现。用 Bash + python 再解析一次或在模型侧用正则：

```
pattern: data-timestamp="(\d+)">([0-9:]+)</a>\s*([^<\n]+)
→ { "timestamp": "02:38", "seconds": 158, "topic": "..." }
```

**时间轴必须严格从页面源得到，禁止模型自行伪造 `00:00:00` 这类时间。**

### Step 5 — 结构化 hosts / guests

- `hosts`：从 shownotes 的 `🎙️主播：xxx、yyy` 或节目固定嘉宾中提取
- `guests`：从标题 / shownotes / 嘉宾段落识别
- `guest_profiles`：仅当 shownotes 明确写了头衔 / 履历时才填，否则置空数组
- 在 `notes` 里明确区分"原始字段"和"模型推断字段"

### Step 6 — 输出 JSON

严格按下节 Schema 组装 JSON。

**流水线模式（给了 `work_dir`）**：
1. 用 `Write` 把 JSON 写到 `<work_dir>/meta.json`
2. 用 `Write` 把 `description + shownotes 去 HTML` 合并后的纯文本写到 `<work_dir>/content.txt`
3. 给调用方返回一行短确认，例如：`meta.json + content.txt 已写入 /workspace/.podcast-work/<eid>/（outline=10 sections, content=3421 chars）`
4. **不要**把完整 JSON 贴回对话

**独立模式**：直接把 JSON 作为最终回复返回，不写盘。

## 输出 Schema

```json
{
  "matched": true,
  "confidence": 0.93,
  "query": { "episode_url": "https://example.com/episode/123" },
  "episode": {
    "title": "本期标题",
    "podcast_name": "播客节目名",
    "description": "节目介绍",
    "guests": ["嘉宾A"],
    "guest_profiles": [
      { "name": "嘉宾A", "title": "AI产品创新专家", "bio": "..." }
    ],
    "hosts": ["主播A"],
    "published_at": "2026-04-01",
    "episode_url": "https://example.com/episode/123",
    "audio_url": "https://media.xyzcdn.net/xxx.m4a",
    "duration": 3900,
    "outline": [
      { "timestamp": "00:02:12", "seconds": 132, "topic": "四十周年巡演" }
    ]
  },
  "source": { "provider": "xiaoyuzhou", "url": "https://example.com/episode/123" },
  "notes": "hosts 根据节目简介推断"
}
```

## 失败与降级

- `curl` 非 200：置信度 < 0.3，返回 `matched: false` + 原始 URL
- 无 `__NEXT_DATA__`：回落到 `og:*` meta 抽取，`provider = page-extract`，`confidence` 相应下调
- 拿到 shownotes 但解析不到时间轴：`outline: []` + `notes: "页面未暴露时间锚点"`

## 硬规则

- **不臆造时间戳**。没时间就空数组。
- **不伪造嘉宾简介**。只有页面明确写了才填 `guest_profiles`。
- **URL 必须真实**（从输入 / 页面里来），不得改写。
