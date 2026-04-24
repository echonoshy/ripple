---
name: bilibili-episode-extract
description: B 站单集原料抓取。输入 URL/BV/短链，产出标题、UP 主、章节、字幕、官方 AI 总结等全部原料到 /workspace/.bilibili-work/<bvid>/。被 bilibili-auto-md 调用；也可独立使用（例如只想拿纯字幕做 QA）。
when-to-use: 用户想"抽取字幕 / 拿视频原料 / 看 AI 总结 / 准备二次处理的中间产物"时调用。如果用户直接想要成品 Markdown，请改调用 bilibili-auto-md。
allowed-tools: [Bash, Read]
metadata:
  requires:
    bins: ["python"]
---

# bilibili-episode-extract

> **PREREQUISITE：** 先读一次 `bilibili-shared/SKILL.md`（URL 解析 + SESSDATA + 输出目录约定）。

## 目的

一次调用把 B 站单集的全部可抓原料落成结构化文件，供下游 skill（`bilibili-auto-md`、未来的 `bilibili-episode-qa` 等）直接 Read。

## 输入

`$ARGUMENTS` 为 JSON：

```json
{
  "url": "https://www.bilibili.com/video/BV1GJ411x7h7?p=1",  // 或 "bvid": "BV1..."
  "sessdata": "可选；未提供则读 /workspace/.bilibili/sessdata.txt；仍无则字幕/总结降级"
}
```

`url` 支持：完整 URL / 分 P URL (`?p=N`) / 裸 BV 号 / `b23.tv` 短链。二选一传 `url` 或 `bvid`。

## 执行（一条命令搞定）

```bash
python /home/lake/workspace/wip/ripple-dev/skills/bilibili/bilibili-episode-extract/pipeline.py \
  --args '<上面的 JSON>'
```

> 脚本内部顺序：解析输入 → `/x/web-interface/view` 拿 meta + cid →（有 SESSDATA 时）拿 WBI mixin_key → `/x/player/wbi/v2` 拿字幕 → `/x/web-interface/view/conclusion/get` 拿官方 AI 总结 → 全部落盘。

## 输出

### stdout：一行 JSON 摘要

```json
{
  "work_dir": "/workspace/.bilibili-work/BV1GJ411x7h7",
  "bvid": "BV1GJ411x7h7",
  "p": 1,
  "cid": 137649199,
  "title": "...",
  "owner": {"mid": 486906719, "name": "..."},
  "duration": 213,
  "pubdate": 1577835803,
  "url": "https://www.bilibili.com/video/BV1GJ411x7h7",
  "stat": {"view": ..., "like": ..., "coin": ..., "share": ..., "favorite": ..., "reply": ..., "danmaku": ...},
  "has_view_points": false,
  "view_points_count": 0,
  "subtitle": {
    "status": "ok | empty | need_sessdata | error",
    "lan": "zh-CN",
    "segments": 120,
    "file": "subtitle.json",
    "text_file": "content.txt"
  },
  "ai_summary": {
    "status": "ok | empty | need_sessdata | error",
    "has_summary": true,
    "outline_sections": 4,
    "file": "summary.json"
  },
  "sessdata_source": "arg | file | none"
}
```

### 磁盘产物（`work_dir` 下）

| 文件 | 内容 |
|---|---|
| `meta.json` | `{ "meta": {...完整元数据}, "view_points": [...] }` |
| `subtitle.json` | `{ "status", "lan", "segments": [{"from","to","content"}] }` |
| `summary.json` | `{ "status", "summary", "outline": [{"title","timestamp","parts":[...]}] }` |
| `content.txt` | 字幕纯文本（按 ~12 秒分段，每行 `[HH:MM:SS] ...`）。仅字幕 `status=ok` 时生成 |

## status 语义

| 字段 | 含义 | 下游处理建议 |
|---|---|---|
| `ok` | 拿到且非空 | 正常使用 |
| `empty` | 接口成功但无此数据（无字幕 / 未生成 AI 总结） | 视情况降级 |
| `need_sessdata` | 未提供 SESSDATA | 提示用户配置（见 `bilibili-shared`） |
| `error` | 接口报错（风控 / Cookie 过期 / 网络） | 读返回体里的 `message` |

## 典型调用示例

```bash
# 完整链路（有 SESSDATA 持久化文件）
python .../pipeline.py --args '{"url":"https://www.bilibili.com/video/BV1xx411c7mD"}'

# 一次性带 SESSDATA（不落盘）
python .../pipeline.py --args '{"bvid":"BV1xx411c7mD","sessdata":"abc...xxx"}'

# 分 P
python .../pipeline.py --args '{"url":"https://www.bilibili.com/video/BV1xx411c7mD?p=3"}'
```

## 硬规则

- **只拉数据、不写 Markdown**。写 MD 是 `bilibili-auto-md` 的职责。
- 单次调用只拉一个视频（或一个分 P）。批量请在上层循环。
- **不要自己写重试循环**——B 站风控期间反复打会封更久。失败就原样把 `code` / `message` 透传给用户。
- 已有 `work_dir` 时**覆盖**写入（B 站数据可能变化，不做缓存；上层若要复用请自行判断时间）。
