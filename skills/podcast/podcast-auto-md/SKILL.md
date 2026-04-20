---
name: podcast-auto-md
description: 用户在聊天里直接发送播客标题或链接时，自动走播客全链路，把每步结果落盘到每期独立的 work_dir，最后用脚本模板渲染成 Markdown 文件返回。
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
  "output_dir": "/workspace/outputs/podcast",
  "prefer_transcript": true,
  "include_full_transcript": true
}
```

## 架构原则（非常重要）

为了避免"最后一个 turn 输出过长被上游断流"，本 skill 采用**每步落盘 + 最后脚本渲染**的流水线，而不是"最后让模型自由写出整份 md"。

- 每期播客都有唯一的 `episode_id` 和 `work_dir`，不同链接互不覆盖
- 每个子 skill 的输出都**立刻写盘到 `work_dir` 下的固定 slot 文件**，只给上游返回一行确认
- 最终 md 的拼装**不由模型自由创作**，而是调用 `render.py` 把 4 个 JSON 套进 TEMPLATE.md
- 这样最后一个 turn 的模型输出量稳定在几百 token，不会再触发 SSE 断流

## work_dir 与 episode_id 规则

- 所有中间文件的根：`/workspace/.podcast-work/<episode_id>/`
- `episode_id` 生成规则（orchestrator 在 Step 1 统一算好，下游所有 skill 复用）：

  | URL 特征 | episode_id |
  |---|---|
  | `xiaoyuzhoufm.com/episode/<eid>` | 取 `<eid>` |
  | `podcasts.apple.com/...?i=<num>` | 取 `i=<num>` 的值 |
  | 其他 | `sha1(episode_url)` 前 12 位 |
  | 只有标题，没有 URL | `sha1("title::" + title)` 前 12 位，临时目录，resolve 成功后换成正式 id 并把旧目录 `mv` 过去 |

- work_dir 中的 slot 文件：

  | 文件 | 写入方 | 内容 |
  |---|---|---|
  | `meta.json` | extract | episode 元信息（title / podcast_name / hosts / guests / outline / audio_url / ...） |
  | `content.txt` | extract（或 auto-md Step 6） | summarize/outline/keywords 的输入文本（description + shownotes 去 HTML + 可选 transcript） |
  | `transcript.json` | transcribe（可选） | `{text, segments}` |
  | `summary.json` | summarize | 三粒度摘要 |
  | `outline.json` | outline | 时间轴 sections |
  | `keywords.json` | keywords | topics/entities/concepts/highlights |

## 执行步骤（必须按此执行）

### Step 1 — 确定 episode_id 和 work_dir

使用 **Bash** 工具执行一次：

```bash
python3 - <<'PY'
import json, re, hashlib, sys, os
args = json.loads(os.environ.get("AUTO_MD_ARGS", "{}"))
url = (args.get("episode_url") or "").strip()
title = (args.get("title") or "").strip()
eid = None
if url:
    m = re.search(r"xiaoyuzhoufm\.com/episode/([0-9a-f]+)", url)
    if m: eid = m.group(1)
    if not eid:
        m = re.search(r"[?&]i=(\d+)", url)
        if m: eid = "apple-" + m.group(1)
    if not eid:
        eid = hashlib.sha1(url.encode()).hexdigest()[:12]
elif title:
    eid = "t-" + hashlib.sha1(("title::" + title).encode()).hexdigest()[:12]
else:
    sys.exit("need title or episode_url")
work_dir = f"/workspace/.podcast-work/{eid}"
print(json.dumps({"episode_id": eid, "work_dir": work_dir}))
PY
```

（实际调用时请把 `$ARGUMENTS` 的 JSON 塞进 `AUTO_MD_ARGS` 环境变量，然后 `mkdir -p <work_dir>`。）

把结果记成 `ep_id` / `work_dir`，后续所有 skill 调用都要把 `work_dir` 一起传下去。

### Step 2 — 判断起点

- 已是 URL → 跳过 resolve，去 Step 3
- 只有标题 → 走 Step 2.5 调 `podcast-episode-resolve`，取 `best_match.episode_url`；若 `matched: false` **立即停止**，把候选给用户选

### Step 3 — 调用 `podcast-episode-extract`

```
Skill(skill="podcast-episode-extract",
      args="{\"episode_url\": \"<url>\", \"work_dir\": \"<work_dir>\"}")
```

该 skill **会自己把 episode 元信息写到 `<work_dir>/meta.json`**，只给你返回一行确认。不要再把完整 JSON 回灌到对话。

### Step 4 — 调用 `podcast-episode-content-resolve`

传入 Step 3 的 meta（可以直接传路径 `<work_dir>/meta.json`）。根据 `strategy` 决定是否要 Step 5：

- `text_only` / `prefer_text_then_audio` → 直接跳到 Step 6
- `audio_only` → Step 5
- `none` → 提前失败，见"失败回退"

### Step 5 — 可选：`podcast-episode-transcribe`

```
Skill(skill="podcast-episode-transcribe",
      args="{\"audio_url\": \"<audio_url>\", \"episode_url\": \"<url>\", \"work_dir\": \"<work_dir>\"}")
```

成功后 transcript 会落到 `<work_dir>/transcript.json`。

### Step 6 — 汇总 content.txt

如果 extract 没自动写 `<work_dir>/content.txt`，用 **Bash** 合成一次：

```bash
python3 - <<'PY'
import json, re, pathlib, html
W = pathlib.Path("<work_dir>")
meta = json.loads((W / "meta.json").read_text())
ep = meta.get("episode", {})
parts = [ep.get("description") or "",
         re.sub(r"<[^>]+>", "", ep.get("shownotes") or "")]
tr = W / "transcript.json"
if tr.exists():
    parts.append(json.loads(tr.read_text()).get("transcript", {}).get("text", ""))
(W / "content.txt").write_text(html.unescape("\n\n".join(p for p in parts if p)))
PY
```

### Step 7 — 并行调用三个内容理解 skill

每个 skill **自己落盘 + 只返回确认行**（不回灌大 JSON）。可以在一个 turn 里并行发起：

```
Skill(skill="podcast-episode-summarize",
      args="{\"work_dir\": \"<work_dir>\"}")
Skill(skill="podcast-episode-outline",
      args="{\"work_dir\": \"<work_dir>\"}")
Skill(skill="podcast-episode-keywords",
      args="{\"work_dir\": \"<work_dir>\"}")
```

三个 skill 会分别写 `summary.json` / `outline.json` / `keywords.json`。

### Step 8 — 用脚本渲染最终 Markdown（**不要让模型自由写 md**）

用 **Bash** 调用本 skill 目录下的 `render.py`：

```bash
python3 "$SKILL_BASE_DIR/render.py" \
  --work-dir "<work_dir>" \
  --template "$SKILL_BASE_DIR/TEMPLATE.md" \
  --output-dir "<output_dir or /workspace/outputs/podcast>" \
  --include-transcript <true|false>
```

脚本会输出一行 JSON：`{"markdown_path": "...", "artifacts": {...}}`。

**禁止**在这一步让模型把完整 md 抄一遍到对话里——那样会复现 Turn 7 断流的老问题。

### Step 9 — 返回 JSON 给上层

根据 Step 8 的 JSON + resolve 信息，组装成下节 Schema 返回。

## 输出 Schema

```json
{
  "matched": true,
  "title": "播客标题",
  "episode_id": "69c80ac524a6ea4a547feae2",
  "work_dir": "/workspace/.podcast-work/69c80ac524a6ea4a547feae2",
  "resolve": {
    "episode_url": "https://www.xiaoyuzhoufm.com/episode/xxxx",
    "source": "search:xiaoyuzhou",
    "confidence": 0.91
  },
  "markdown_path": "/workspace/outputs/podcast/2026-03-29-a-gu-zuoye-bang.md",
  "artifacts": {
    "meta": true,
    "summary": true,
    "outline": true,
    "keywords": true,
    "transcript": false
  },
  "notes": "无 ASR，基于 shownotes"
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
- 最终 md 由 `render.py` 生成，**不由模型在对话里写出整份 md**
- 每期播客使用独立 `work_dir`（见上方 episode_id 规则），多链接之间不会互相覆盖
- 区分"原始信息"（meta）和"模型生成信息"（summary / outline / keywords）
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
| 单个子 skill 失败 | work_dir 里对应 slot 缺失，`render.py` 自动降级为占位文案，不中断整条流水线 |

## 备注

- 这是一个**编排 skill**，不替代底层 skill，只把它们串成用户可直接感知的最终产物。
- 每次调用 `Skill(...)` 都是真实调用，不能只在对话里"声明自己做了"。
- 任何时候**不要**把大段 JSON / 完整 md 抄回到对话正文里——这是让最后一个 turn 断流的主因。对话里只保留路径和简短状态，完整内容一律靠 work_dir 文件接力。
