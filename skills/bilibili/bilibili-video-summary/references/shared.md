# B 站视频总结共享约定

`bilibili-video-summary` 是唯一对外暴露的 B 站视频总结 skill。`bilibili` CLI 是预装在 sandbox PATH 里的单二进制 helper，负责解析输入、抓取 B 站原料并输出 JSON；登录、二维码轮询、账号状态和断开连接都由 Ripple server connector control plane 负责。

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

主流程只使用：

```bash
bilibili extract --url "<URL 或 BV>" --json
bilibili prepare-md --url "<URL 或 BV>" --json
```

stdout 永远按 JSON 解析；stderr 只当诊断日志，不要解析。

## 登录态

B 站字幕和官方 AI 总结需要 SESSDATA。真实凭证保存于 Ripple server 的 per-user credentials 目录：

```text
.ripple/sandboxes/<user_id>/credentials/bilibili.json
```

在 nsjail sandbox 内，server 会把这个文件以只读方式挂载到 CLI 默认读取路径：

```text
/workspace/.bilibili/sessdata.json
```

不要让用户打开 DevTools 复制 Cookie，不要在对话里回显完整 SESSDATA / `bili_jct`，也不要调用 `bilibili auth start/poll/status/logout`。如果登录态缺失或过期，回复内部 `<ripple_connector_auth_request>` 让 Ripple server 处理授权。

## 输出目录

| 路径 | 用途 |
|---|---|
| `/workspace/.bilibili-work/<bvid>[-p<N>]/` | `extract` 中间产物：`meta.json`、`subtitle.json`、`summary.json`、`content.txt` |
| `/workspace/outputs/bilibili/YYYY/MM/YYYY-MM-DD-<bvid>-<slug>.md` | `bilibili-video-summary` 最终 Markdown |

## 失败处理

| 现象 | 处理 |
|---|---|
| `prepare-md` 返回 `auth_required=true` 或顶层 `error.code="bilibili_auth_required"` | 不写 Markdown；回复内部 `<ripple_connector_auth_request>` |
| `subtitle.status = need_sessdata` 且 `ai_summary.status = need_sessdata` | 登录态缺失或过期；不写 Markdown，触发 Ripple connector 授权 |
| `subtitle.status = error` 或 `ai_summary.status = error` | 面向用户的 Markdown 里按「无字幕 / 无 AI 总结」处理，不暴露风控码 |
| `code: -101` | 登录失效，触发 Ripple connector 授权 |
| `code: -352` / `-412` 或 HTTP `412` | 风控；不要死循环重试，按缺失字幕/总结降级或提示稍后再试 |

## 绝对禁止

- 让用户开 DevTools 找 SESSDATA。
- 在对话里回显完整 Cookie。
- 调用 `bilibili auth start/poll/status/logout` 处理登录。
- 用正则抓 B 站网页替代 `bilibili extract` / `bilibili prepare-md`。
- 在未登录时产出只基于标题/简介的半成品 Markdown。
