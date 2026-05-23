---
name: podcast-episode-transcribe
description: 下载播客音频并执行转写，生成 transcript，作为文本内容不足时的兜底。
when-to-use: 只有 audio_url / 音频文件，或 content-resolve 判定文本不足，或用户明确要求"把这段播客转成文字"
allowed-tools: [Bash]
---

# podcast-episode-transcribe

## 目的

内容获取层的**兜底 skill**：文本不够时，用音频转写补齐，产出可供 summarize / outline / keywords / qa 下游使用的 transcript。

## 输入

`$ARGUMENTS` 可以是裸 URL，或 JSON：

```json
{
  "audio_url": "https://cdn.example.com/audio.mp3",
  "episode_url": "https://example.com/episode/123",
  "title": "播客标题",
  "podcast_name": "播客节目名",
  "language": "zh",
  "need_timestamps": true,
  "work_dir": "/workspace/.podcast-work/<episode_id>"
}
```

- 传了 `work_dir` 时：**transcript.json 必须写入 `<work_dir>/transcript.json`**，让 auto-md 下游自动捡到
- 没传 `work_dir`：按原逻辑写 `/workspace/.tmp-transcribe/`，并把路径写进输出 JSON

## 执行步骤（必须按此执行）

### Step 1 — 解析输入

取 `audio_url`（必填）、`language`（默认 `zh`）、`need_timestamps`（默认 `true`）、`work_dir`（可选）。

### Step 2 — 能力探测

当前仓库**没有内置 ASR 工具**。按以下顺序探测宿主是否可用：

```bash
which whisper 2>/dev/null
which whisper-cpp 2>/dev/null
which faster-whisper 2>/dev/null
which ffmpeg 2>/dev/null
```

若全部不可用：**立即走 Step 5 降级路径**，不要继续尝试下载音频浪费时间。

### Step 3 — 下载音频到 workspace

若探测到可用 ASR：

```bash
mkdir -p /workspace/.tmp-transcribe
curl -sL --fail -o /workspace/.tmp-transcribe/audio.m4a "<audio_url>" \
  -H "User-Agent: Mozilla/5.0" \
  -H "Referer: <episode_url>"
ffmpeg -hide_banner -loglevel error -y \
  -i /workspace/.tmp-transcribe/audio.m4a \
  -ar 16000 -ac 1 /workspace/.tmp-transcribe/audio.wav
```

### Step 4 — 执行转写

以 `whisper.cpp` 为例（若使用别的引擎，保持相同产物结构）：

```bash
whisper-cpp -m <model.bin> -l zh -osrt \
  -f /workspace/.tmp-transcribe/audio.wav \
  -of /workspace/.tmp-transcribe/out
```

从 `.srt` 解析出 `segments`，每段 `{ start, end, text }`，拼出 `transcript.text`。

### Step 5 — 成功落盘

完成转写后，用 **Bash 里的 Python 脚本**直接把结构化结果写入 `transcript.json`（**不要**让模型用 Write 工具手写这种可能很大的 JSON）：

```bash
python - <<'PY'
import json, pathlib
work = pathlib.Path("<work_dir 或 /workspace/.tmp-transcribe>")
work.mkdir(parents=True, exist_ok=True)
payload = {
    "matched": True,
    "source": {"type": "audio_file", "url": "<audio_url>"},
    "transcript": {"text": "<...>", "language": "zh", "segments": [...]},
    "quality": {"mode": "asr:whisper.cpp", "confidence": "medium"},
    "notes": "默认不做 speaker diarization",
}
(work / "transcript.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
print("transcript.json written")
PY
```

### Step 6 — 无 ASR 时的硬降级

若 Step 2 探测失败，**不要假装转写成功**。若传了 `work_dir`，同样用 Bash 落一份"明确失败"标记，方便 auto-md 渲染降级：

```bash
python - <<'PY'
import json, pathlib
work = pathlib.Path("<work_dir>")
work.mkdir(parents=True, exist_ok=True)
(work / "transcript.json").write_text(json.dumps({
    "matched": False,
    "source": {"type": "audio_file", "url": "<audio_url>"},
    "transcript": None,
    "quality": {"mode": "unavailable", "confidence": "none"},
    "notes": "沙箱未安装 ASR (whisper/whisper.cpp/faster-whisper)。"
}, ensure_ascii=False, indent=2), encoding="utf-8")
PY
```

然后只向调用方返回一行状态 + `matched: false`，不要把完整 JSON 抄回对话。

## 输出 Schema（成功时）

```json
{
  "matched": true,
  "source": { "type": "audio_file", "url": "https://cdn.example.com/audio.mp3" },
  "transcript": {
    "text": "完整转写文本",
    "language": "zh",
    "segments": [ { "start": 0.0, "end": 12.4, "text": "第一段转写内容" } ]
  },
  "quality": { "mode": "asr:whisper.cpp", "confidence": "medium" },
  "notes": "默认不做 speaker diarization"
}
```

## 硬规则

- **没 ASR 就报告没 ASR**，绝不以 shownotes / description 伪装成 transcript。
- transcript 必须带 `segments` 时间戳（outline 下游强依赖）；确实拿不到就在 `notes` 里说明。
- 默认不做 speaker diarization；若要做需显式在 `$ARGUMENTS` 里传 `diarize: true`。
