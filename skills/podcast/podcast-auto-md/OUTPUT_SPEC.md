# Podcast Auto MD Output Spec

## 目标

当用户直接发送播客标题时，系统自动生成一份 Markdown 文件，并将该文件作为最终产物返回。

## 推荐输出目录

优先使用：
- `projects/podcast-agent-min/outputs/`

后续正式化后可迁移到：
- `outputs/podcast/`

## 推荐文件命名规则

```text
YYYY-MM-DD-<slugified-title>.md
```

例如：

```text
2026-04-14-cui-jian-luo-yong-hao.md
```

## 最低内容要求

即使 transcript 暂时缺失，也至少应包含：
- 标题
- 播客名
- 嘉宾 / 主播
- 嘉宾信息（若 shownotes 中可提取）
- resolve 结果（至少 episode URL）
- 节目简介
- Summary
- Outline
- Keywords
- Sources
- Notes

## 完整内容要求

如果 transcript 已可获得，则完整 Markdown 应包含：
- Title
- Metadata
- Guest Profiles（guest title / bio，若可得）
- Resolve Result（episode URL + source + confidence，若可得）
- Description
- Summary
- Outline（必须优先使用 `00:02:00 章节标题` 这种时间轴目录格式）
- Keywords
- Full Transcript
- Sources
- Notes

## 降级策略

### 情况 1：resolve 失败
- 不输出最终 md
- 返回候选列表给用户确认

### 情况 2：extract 成功但 transcript 失败
- 仍输出精简版 md
- 在 Notes 里注明 transcript 缺失

### 情况 3：音频转写 processing 超时
- 先产出 metadata + summary + outline + keywords 版本
- 后续 transcript 完成可覆盖更新

### 情况 4：只有主题，没有真实播客源
- 只能输出“主题整理稿”
- 不能伪装成真实播客逐段整理结果
- Outline 不得输出伪时间轴

## 产品要求

- 结构固定，便于归档
- 能直接发给用户
- Markdown 应尽量可读，不要只堆 JSON
- Guest Profiles 在最终成品里应尽量渲染成自然语言简介，而不是原始 JSON
- Outline 在最终成品里必须直接输出为时间轴目录，例如：
  - `00:00:34 30年前的合影`
  - `00:02:12 四十周年巡演`
- 不能把 outline 渲染成 `### 1. ...` 这种文章式目录
- 如果没有真实时间信息，应明确写“暂无时间轴”，而不是改写成文章式章节标题
- 区分：原始来源信息 vs 模型生成内容
