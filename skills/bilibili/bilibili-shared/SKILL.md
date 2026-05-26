---
name: bilibili-shared
description: B 站（bilibili）skill 的通用纪律：URL/BV 解析规则、`bilibili` 二进制、扫码登录流程、沙箱输出目录约定、鉴权降级策略。任何 bilibili-* 子 skill 首次被调用前必读。
when-to-use: 调用任何 bilibili-* skill（extract / auto-md / 后续子 skill）之前，只需读一次；不需要重复读。
metadata:
  requires:
    bins: ["bilibili"]
  cliHelp: "bilibili --help"
---

# bilibili-shared

所有 `bilibili-*` 子 skill 共享这套约定。`bilibili` 是预装在 sandbox PATH 里的单二进制 CLI；不要再调用旧的 Python pipeline，也不要再调用旧的 model-facing auth tools。

## 输入形态

`bilibili` CLI 支持：

| 形态 | 示例 |
|---|---|
| 裸 BV 号 | `BV1GJ411x7h7` |
| 完整视频 URL | `https://www.bilibili.com/video/BV1GJ411x7h7/?spm_id_from=...` |
| 分 P URL | `https://www.bilibili.com/video/BV1GJ411x7h7?p=3` |
| 短链 | `https://b23.tv/xxxxxx` |

业务命令统一传 `--url "<URL 或 BV>" --json`。CLI 内部解析成 `(bvid, p)`；短链由 CLI 跟随跳转。

## CLI 命令

```bash
bilibili --help
bilibili auth start --json
bilibili auth poll --qrcode-key "<key>" --max-wait 30 --json
bilibili auth status --verify --json
bilibili auth logout --json
bilibili extract --url "<URL 或 BV>" --json
bilibili prepare-md --url "<URL 或 BV>" --json
```

stdout 永远按 JSON 解析；stderr 只当诊断日志，不要解析。

## 登录态

B 站字幕和官方 AI 总结通常需要 SESSDATA。默认登录态文件：

```text
/workspace/.bilibili/sessdata.json
```

这是 user workspace 内的隐藏状态目录，和 `gog` 的 `/workspace/.config/gogcli/` 模式一致。不要让用户打开 DevTools 复制 Cookie，不要在对话里回显完整 SESSDATA / `bili_jct`。

### 两段式扫码流程

1. 先运行：

```bash
bilibili auth start --json
```

2. 如果返回 `stage="authorized"` 或 `data.bound=true`，直接继续业务命令。

3. 如果返回 `stage="awaiting_user"`，从 `data` 里取：

| 字段 | 用途 |
|---|---|
| `qrcode_key` | 下一 turn 传给 `auth poll` |
| `qrcode_image_url` | 前端二维码卡片图片 URL |
| `qrcode_content` | B 站扫码 URL |
| `app_url` | B 站 App deep link |

回复用户时只输出下面这个授权块和一句指引，然后结束本 turn：

```text
[BILIBILI_AUTH]
B 站扫码登录

<qrcode_image_url>

<qrcode_content>

<app_url>

扫码或点链接确认后，回到这里发送「好了」。
```

不要在同一个 turn 里 poll；等用户回「好了/ok/扫好了」再继续。

4. 下一 turn 运行：

```bash
bilibili auth poll --qrcode-key "<qrcode_key>" --max-wait 30 --json
```

处理规则：

| 返回 | 处理 |
|---|---|
| `stage="authorized"` | 凭证已写入 `/workspace/.bilibili/sessdata.json`，继续原任务 |
| `stage="pending"` + `data.last_state="scanned"` | 告诉用户还需要在 App 里点确认，结束 turn |
| `stage="pending"` + `data.last_state="waiting_scan"` | 告诉用户还没收到扫码，结束 turn |
| `stage="expired"` / `stage="timeout"` | 问用户是否重新生成二维码；同意后重新 `auth start` |

用户说「算了/不登录了/取消」时运行：

```bash
bilibili auth logout --json
```

然后按用户意图收尾或走降级。

## 输出目录

| 路径 | 用途 |
|---|---|
| `/workspace/.bilibili/sessdata.json` | 扫码登录凭证 |
| `/workspace/.bilibili-work/<bvid>[-p<N>]/` | `extract` 中间产物：`meta.json`、`subtitle.json`、`summary.json`、`content.txt` |
| `/workspace/.outputs/bilibili/YYYY-MM-DD-<bvid>-<slug>.md` | `auto-md` 最终 Markdown |

## 鉴权降级

默认不要降级。用户说「总结一下 XXX」默认要质量好的结果，也就是优先用字幕和官方 AI 总结。

只有用户明确说「不要登录 / 不用登录 / 别扫码 / 只要元数据 / 直接给我」时，才允许：

```bash
bilibili prepare-md --url "<URL 或 BV>" --allow-unauthenticated --json
```

如果 `prepare-md` 返回 `auth_required=true` 或顶层 `error.code="bilibili_auth_required"`，不要写 Markdown，不要调用 Write，先走扫码流程。

## 失败处理

| 现象 | 处理 |
|---|---|
| `subtitle.status = need_sessdata` 且 `ai_summary.status = need_sessdata` | 运行 `bilibili auth status --verify --json`；无效则重新扫码 |
| `subtitle.status = error` 或 `ai_summary.status = error` | 面向用户的 Markdown 里按「无字幕 / 无 AI 总结」处理，不暴露风控码 |
| `code: -101` | 登录失效，重新扫码 |
| `code: -352` / `-412` 或 HTTP `412` | 风控；不要死循环重试，按缺失字幕/总结降级或提示稍后再试 |

## 绝对禁止

- 让用户开 DevTools 找 SESSDATA。
- 在对话里回显完整 Cookie。
- 用正则抓 B 站网页替代 `bilibili extract`。
- 在未登录且用户没有明确拒绝登录时，产出只基于标题/简介的半成品 Markdown。
