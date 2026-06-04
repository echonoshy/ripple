---
name: notion-files
version: 1.0.0
description: "Use when a Notion task needs file upload, image/file/PDF blocks, page cover or icon media, external URL imports, or file_upload ids."
metadata:
  requires:
    bins: ["ntn"]
    connectors: ["notion"]
  cliHelp: "ntn files --help"
---

# notion-files：文件上传

**CRITICAL — 开始前 MUST 先读取 [`../notion-shared/SKILL.md`](../notion-shared/SKILL.md)**。

## `ntn files` 子命令一览

先跑这个看看你当前 ntn 版本到底支持哪些子命令（版本间会增减）：

```bash
ntn files --help
```

最核心的三个：

```bash
# 上传本地文件（从 stdin 喂二进制）
ntn files create --json < /workspace/image.png

# 或者让 Notion 从外链抓
ntn files create --external-url https://example.com/photo.png --json

# 列出 / 查询已上传
ntn files list --json
ntn files get <upload-id> --json
```

## 上传流程（两步）

Notion 的文件模型是 **"先上传拿 id，再把 id 嵌进 block / property"**。
光上传完什么都看不到，必须第二步把它绑到 page 上。

### 第 1 步：上传

```bash
# 本地文件
ntn files create --filename image.png --content-type image/png --json < /workspace/image.png > upload.json

# 读出 file_upload_id
UPLOAD_ID=$(jq -r '.id' upload.json)
```

常见字段：
- `.id` — file_upload_id，后续一切靠它
- `.status` — `pending` / `uploaded` / `failed` / `expired`；`uploaded` 才能拿去嵌
- `.expiry_time` — upload id 的过期时间；不要长期保存一个悬置 upload id

如果是外链导入或返回 `pending`，轮询到终态：

```bash
ntn files get "$UPLOAD_ID" --json
```

### 第 2 步：把 `file_upload_id` 绑到 page

**2a. 作为 page 里的一个图片 block：**

```bash
ntn api -X PATCH v1/blocks/{page_id}/children -d "{
  \"children\": [{
    \"object\": \"block\",
    \"type\": \"image\",
    \"image\": {
      \"type\": \"file_upload\",
      \"file_upload\": {\"id\": \"${UPLOAD_ID}\"}
    }
  }]
}"
```

**2b. 作为一个通用附件 block（PDF / zip 等）：**

```bash
ntn api -X PATCH v1/blocks/{page_id}/children -d "{
  \"children\": [{
    \"object\": \"block\",
    \"type\": \"file\",
    \"file\": {
      \"type\": \"file_upload\",
      \"file_upload\": {\"id\": \"${UPLOAD_ID}\"}
    }
  }]
}"
```

**2c. 作为 page 的 cover：**

```bash
ntn api -X PATCH v1/pages/{page_id} -d "{
  \"cover\": {
    \"type\": \"file_upload\",
    \"file_upload\": {\"id\": \"${UPLOAD_ID}\"}
  }
}"
```

**2d. 作为 page 的 icon：**

```bash
ntn api -X PATCH v1/pages/{page_id} -d "{
  \"icon\": {
    \"type\": \"file_upload\",
    \"file_upload\": {\"id\": \"${UPLOAD_ID}\"}
  }
}"
```

当前 API 也支持 `external.url`、emoji、Notion native icon 等形式；不确定时先跑
`ntn api --spec /v1/pages/{page_id} -X PATCH` 查 `pageIconRequest` / `pageCoverRequest`。

## 外链 vs 上传，怎么选？

| 场景 | 选 |
|------|----|
| 已经有公网 URL（CDN / GitHub raw / 图床） | `--external-url`，**不过** Notion 会在第一次访问时把它抓回去存，仍然产生一次外网请求 |
| 本地生成的文件（截图、渲染出来的图） | 上传本地文件（`ntn files create --json < file`） |
| 要作为 page cover / icon 用 | 可以用 `file_upload`，也可以用 `external.url` |
| 大文件 / 上传失败 | 先读 `ntn api --docs /v1/file_uploads -X POST`，必要时走 multi-part 流程 |

## 常见错误

| 错误 | 原因 / 处理 |
|------|-------------|
| `validation_error: file too large` | 超过 workspace 的文件大小限制；让用户压缩或分片 |
| `validation_error: Invalid file_upload.id` | upload_id 拼错、或者 upload 还没完成（`status != uploaded`）就拿去用了 |
| block 显示成一个"不可访问的文件" | 大概率是 file_upload 还没完成；等 1-2s 再 retry |

## 快速决策

| 用户意图 | 步骤 |
|----------|------|
| "把这张图放进笔记" | `ntn files create --json < img.png` → 取 id → PATCH `v1/blocks/{page_id}/children` 追加 `image` block |
| "给这个页面加个 PDF 附件" | `ntn files create --json < doc.pdf` → 追加 `file` block |
| "设置页面封面" | 上传后 PATCH `v1/pages/{page_id}` 的 `cover.file_upload.id` |
| "看看已经传过哪些文件" | `ntn files list --json` |

## 最后提醒

- `NOTION_API_TOKEN` 必须已注入（见 notion-shared），否则 `files create` 第一句话就会失败
- 上传成功后**立刻**把 `file_upload_id` 嵌到 page 里；不要在对话里让它长期悬置
- 批量上传（>5 个文件）前先跟用户确认一次完整计划
