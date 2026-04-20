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
  "need_timestamps": true
}
```

## 执行步骤（必须按此执行）

### Step 1 — 解析输入

取 `audio_url`（必填）、`language`（默认 `zh`）、`need_timestamps`（默认 `true`）。

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

### Step 5 — 无 ASR 时的硬降级

若 Step 2 探测失败，**不要假装转写成功**，直接返回：

```json
{
  "matched": false,
  "source": { "type": "audio_file", "url": "<audio_url>" },
  "transcript": null,
  "quality": { "mode": "unavailable", "confidence": "none" },
  "notes": "当前沙箱未安装 ASR（whisper/whisper.cpp/faster-whisper）。请走文本来源，或在宿主启用 ASR 后重试。"
}
```

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
