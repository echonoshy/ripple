---
name: podcast-episode-extract
description: 根据已知的 episode URL，抽取该期播客的结构化元信息（标题、节目名、简介、嘉宾、主播、章节 outline 等）。不负责搜索 URL。流水线模式下由 Bash 直接落盘 meta.json / content.txt，绝不让模型手写 JSON。
when-to-use: 用户提供了播客单集链接，或上游 skill 已经拿到 episode_url 需要取元信息时
allowed-tools: [Bash]
---

# podcast-episode-extract

## 目的

**episode URL → 结构化元信息。** 标题解析层的第二段：只 extract，不 resolve。

> ⚠️ **不要让模型在对话里 Write 大 JSON**。所有落盘必须在同一个 Bash 命令里用 Python 的 `json.dumps(...).write_text(...)` 完成。过去让模型手写 meta.json 导致「中文引号未转义 → JSON 解析失败 → 整条流水线重做」的故障，此 skill 已禁止该做法（`allowed-tools` 不含 `Write`）。

## 输入

`$ARGUMENTS` 既可是一个裸 URL 字符串，也可是 JSON：

```json
{
  "episode_url": "https://www.xiaoyuzhoufm.com/episode/69cdbe5eb977fb2c47e1e409",
  "work_dir": "/workspace/.podcast-work/<episode_id>"
}
```

## 首选做法：调用 auto-md 的 pipeline.py

如果 `podcast-auto-md/pipeline.py` 可用，**优先直接用它**，一条命令就能完成抓取 + 落盘 + strategy 判断：

```bash
python3 $RIPPLE_SKILLS_DIR/podcast/podcast-auto-md/pipeline.py prepare \
  --args '{"episode_url": "<url>"}'
```

输出 JSON 里带 `work_dir` / `output_path` / `strategy` / `text_chars` / `has_outline` / `audio_url`，上层 SKILL（如 podcast-auto-md）拿到后只需 Read `meta.json` + `content.txt` 即可直接产出 markdown。

## 备选做法：独立抽取（无 pipeline.py 时）

### Step 1 — 解析输入

- URL 清洗：去掉 `?utm_*` 这类跟踪参数
- 依据 host 选抽取策略：

  | host | provider | 抽取方式 |
  |---|---|---|
  | `xiaoyuzhoufm.com` | `xiaoyuzhou` | `__NEXT_DATA__` 内嵌 JSON |
  | `podcasts.apple.com` | `apple-podcasts` | `<meta>` + JSON-LD |
  | 其他 | `page-extract` | `og:*` meta + 正文启发式 |

### Step 2 — 抓页面 + 解析 + 落盘（一个 Bash 命令完成）

```bash
python3 <<'PY'
import json, re, html, pathlib, urllib.request

URL = "<episode_url>"
WORK = pathlib.Path("<work_dir>")
WORK.mkdir(parents=True, exist_ok=True)

req = urllib.request.Request(URL, headers={
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "zh-CN,zh;q=0.9",
})
raw = urllib.request.urlopen(req, timeout=20).read().decode("utf-8", errors="replace")

m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', raw, re.DOTALL)
if not m:
    raise SystemExit("no __NEXT_DATA__")

data = json.loads(m.group(1))
ep = (data.get("props") or {}).get("pageProps", {}).get("episode") or {}
pod = ep.get("podcast") or {}

outline = [
    {"seconds": int(mo.group(1)), "timestamp": mo.group(2).strip(), "topic": mo.group(3).strip()}
    for mo in re.finditer(r'data-timestamp="(\d+)">([0-9:]+)</a>\s*([^<\n]+)', ep.get("shownotes") or "")
]

meta = {
    "matched": True, "confidence": 0.97,
    "episode": {
        "title": ep.get("title"),
        "podcast_name": pod.get("title"),
        "hosts": [], "guests": [], "guest_profiles": [],
        "published_at": ep.get("pubDate"), "duration": ep.get("duration"),
        "episode_url": URL,
        "audio_url": (ep.get("enclosure") or {}).get("url") or ep.get("mediaKey"),
        "description": ep.get("description"),
        "shownotes": ep.get("shownotes"),
        "outline": outline,
    },
    "source": {"provider": "xiaoyuzhou", "url": URL},
    "notes": "meta 由 extract skill 通过 Bash 落盘",
}
(WORK / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))

# content.txt：description 通常是 shownotes 的复述，做去重
desc = (ep.get("description") or "").strip()
sn = html.unescape(re.sub(r"<[^>]+>", "", ep.get("shownotes") or "")).strip()
content = sn if (desc and sn.startswith(desc[:80])) else ("\n\n".join(p for p in [desc, sn] if p))
(WORK / "content.txt").write_text(content)

print(f"meta.json + content.txt written to {WORK} (outline={len(outline)}, content_chars={len(content)})")
PY
```

### Step 3 — 给调用方返回短确认

只回一行状态，**绝不**把完整 JSON / shownotes / description 抄回对话。

## 输出 Schema（写入 `<work_dir>/meta.json`）

```json
{
  "matched": true,
  "confidence": 0.93,
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

- `curl` / `urlopen` 非 200：写 `{"matched": false, ...}` 到 `meta.json`，在 `notes` 写原因
- 无 `__NEXT_DATA__`：回落到 `og:*` meta 抽取，`provider = page-extract`，`confidence` 下调
- 拿到 shownotes 但解析不到时间轴：`outline: []` + `notes: "页面未暴露时间锚点"`

## 硬规则

- **不臆造时间戳**。没时间就空数组。
- **不伪造嘉宾简介**。只有页面明确写了才填 `guest_profiles`。
- **URL 必须真实**（从输入 / 页面里来），不得改写。
- **不要用 Write 工具落盘**。这是为了避免模型手写 JSON 时出现引号转义错误。
