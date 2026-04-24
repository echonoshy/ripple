---
name: bilibili-auto-md
description: 用户给一个 B 站视频 URL / BV 号，直接产出一份完整 Markdown：在对话里完整呈现，同时落盘到 /workspace/.outputs/bilibili/。内部先调 bilibili-episode-extract 抓字幕 + 官方 AI 总结 + 元数据，再由模型按模板写出 MD。
when-to-use: 用户发送一个 B 站视频链接/BV 号，希望直接拿到 Markdown 总结；或说"帮我整理 / 总结一下这个视频"。
allowed-tools: [Skill, Bash, Write, Read]
metadata:
  requires:
    bins: ["python"]
---

# bilibili-auto-md

> **PREREQUISITE：** 先读 `bilibili-shared/SKILL.md`（URL 解析 + SESSDATA + 目录约定）。

## 目的

> 用户只发一个 B 站 URL / BV → 你产出一份完整 Markdown → 同时**在对话里展示给用户** + **落盘到指定路径**。

## 触发

- 输入是 B 站视频链接、BV 号、`b23.tv` 短链
- "帮我整理这个视频 / 生成 md / 总结一下"

## 输入

`$ARGUMENTS` 可以是：
- 裸 URL：`https://www.bilibili.com/video/BV1xx411c7mD`
- 裸 BV：`BV1xx411c7mD`
- 短链：`https://b23.tv/xxxxxx`
- JSON：`{"url": "...", "sessdata": "...", "output_dir": "..."}`

## 流程（3 步：确认登录态 → 抓取 → 写 MD）

### Step 0 — 一次调用确认登录态（**两段式扫码**，默认先登录，别降级）

直接调 `BilibiliLoginStart`——它**自带状态检查**，不需要先调 `BilibiliAuthStatus`
预热一次（那是白烧一个 round-trip）。根据返回的 `bound` 字段分两支处理：

- `bound=true` → 凭证已绑定且未过期。可顺便看 `days_until_expiry`：≤ 7 时礼貌提
  醒一句"登录还有 N 天到期，要不要顺便续一下"，然后**直接进 Step 1**。

- `bound=false` → 工具已发了新二维码 + 把扫码闸门关上了，走两段式扫码：

  **Turn A（当前这个 turn）**：拿到 `qrcode_key` + `qrcode_image_url` 后，回复里
  **只给**用户两样东西：
    1. 一个 markdown 链接 `[点此查看扫码二维码](qrcode_image_url)`（用户在浏览器
       打开就是一张真正可扫的 PNG 二维码）；
    2. 一句指引「请用 B 站 App 扫一扫 → 在 App 里点『确认登录』→ 扫完后回我一句
       「好了」我再继续」。
  然后**结束本 turn**——**不要**在本 turn 内调 `BilibiliLoginPoll`；**不要**在
  本 turn 内抢跑 Step 1（抢了也会被扫码闸门挡回）。

  ⚠️ **绝对不要**把 `qrcode_content` 字段当链接给用户——它是扫码**完成后**的 B
  站落地页，浏览器打开只会看到"下载 B 站 App"，不是二维码。
  ⚠️ 也**不要**尝试 `![image](qrcode_image_url)` 直接内嵌——这条相对路径图片在
  不少 markdown 渲染器里会 fail，改用 link 形式最稳。
  ⚠️ **绝对禁止**在回复里贴 ASCII / Unicode 方块二维码。工具从 v2 起不再返回
  `qrcode_ascii` 字段；也**不要**自己渲染。只给链接就够。

  **Turn B（用户回「好了/ok/扫好了」之后的下一 turn）**：调
  `BilibiliLoginPoll(qrcode_key=...)`（默认 30s 短等待）：
    - state=`ok`      → 凭证已落盘，继续 Step 1。
    - state=`pending` + `last_state: "scanned"` → 用户扫了但没点确认登录。回复
      「扫到了，但你还要在 B 站 App 里点一下『确认登录』。点完回我一句我重试。」
      然后**结束本 turn**，等用户回话再 poll 一次。
    - state=`pending` + `last_state: "waiting_scan"` → 用户还没扫。回复「好像
      还没收到扫码——二维码还在那条链接里，麻烦扫一下，扫完回我。」然后**结束
      本 turn**，等用户回话再 poll 一次。
    - state=`expired` → 二维码超时；问用户「要不要重新来」，同意再 `LoginStart`。
    - state=`timeout` → 同上。

  若用户中途说「算了/不登录了/取消」：调 `BilibiliLogout` 释放闸门，然后按用户
  意图继续（或走下面的降级路径）。

  - **禁止自作主张降级**：没登录就产出一份带 `⚠️ 未登录` 警告的残疾 MD 是糟糕
    UX，属于违规；用户问「总结一下 XXX」默认是"要质量好的总结"，不是"任何半成品都行"。
  - **降级的唯一触发条件**：用户在对话里**明确说过**"不要登录 / 不用登录 / 别扫码 /
    直接给我 / 只要元数据 / 就用标题简介" 之类的字样。否则一律走扫码。

Step 1 跑完如果 `subtitle.status` 或 `ai_summary.status` 出现
`need_sessdata` / 疑似鉴权失败，再调一次 `BilibiliAuthStatus(verify=true)` 确认
是不是 SESSDATA 失效了；失效就重新扫码再重跑 pipeline。

### Step 1 — 用 pipeline.py 一键抓取 + 算出 output_path

```bash
python /home/lake/workspace/wip/ripple-dev/skills/bilibili/bilibili-auto-md/pipeline.py \
  --args '{"url": "<url 或 BV>"}'
```

输出一行 JSON，关键字段：

| 字段 | 说明 |
|---|---|
| `work_dir` | `/workspace/.bilibili-work/<bvid>[-p<N>]/`，含 `meta.json` / `subtitle.json` / `summary.json` / `content.txt`（字幕 ok 时） |
| `output_path` | **最终 md 落盘路径**，默认 `/workspace/.outputs/bilibili/YYYY-MM-DD-<bvid>-<slug>.md` |
| `title` / `owner` / `duration` / `pubdate` / `url` / `stat` | 元信息摘要 |
| `subtitle.status` | `ok` / `empty` / `need_sessdata` / `error` |
| `ai_summary.status` | 同上 |
| `has_view_points` + `view_points_count` | 是否有 UP 主打的原生章节 |

如果输出有 `error` 字段（网络 / 风控 / 找不到 BV），直接把错误告诉用户，**不**继续写 MD。

### Step 2 — 读原料 → 组装 MD 字符串 → Write 落盘 → 原文贴回对话（顺序严格）

1. **Read** `<work_dir>/meta.json` 拿 meta + view_points
2. 若 `ai_summary.status == "ok"`：**Read** `<work_dir>/summary.json` 拿 summary + outline（优先用这个做"摘要"和"时间轴"）
3. 若 `subtitle.status == "ok"`：**Read** `<work_dir>/content.txt` 拿字幕纯文本（用作"要点"的素材源 + AI 总结缺失时的兜底）
4. 按下面"模板与硬规则"在心里（不要先贴给用户）组装出**一段** Markdown 字符串，记作 `MD`
5. **用 `Write` 工具**把 `MD` 落盘到 `output_path`（工具返回 success 即可，不用读回来）
6. 在**同一条**回复里把 **`MD` 原封不动**（逐字符等同，**禁止**加 emoji 标题 / 改表格 / 重排列表 / 加粗小标题 / 换章节顺序）贴在对话正文里给用户看
7. 末尾补一行 `已生成: <output_path>（约 N 字、M 个章节）`

> 关键硬约束：**"贴给用户看的内容" 必须和 "Write 工具写进文件的内容" 一字不差。**
> 这两份不是"两份产出"，是**同一个字符串的两处引用**。装饰化改写 = 违规。
> 如果你忍不住想"给用户看的版本稍微漂亮一点"——忍住。用户会打开文件的，和你给他看的不一样会让他困惑到底哪个是真的。

### Step 3 — 末尾用一行说明确认

`已生成: <output_path>（约 N 字、M 个章节）`

## 模板与硬规则（直接照抄）

```markdown
# {{meta.title}}{{ 若 p>1 则追加 " · P" + p + ": " + meta.part_title }}

- **UP 主**：{{meta.owner.name}}（mid: {{meta.owner.mid}}）
- **发布**：{{meta.pubdate | YYYY-MM-DD}}
- **时长**：{{meta.duration | "X 分 Y 秒"}}
- **数据**：{{stat.view | 用 万 / 亿 格式}} 播放 · {{stat.like | 万}} 点赞 · {{stat.coin}} 投币 · {{stat.favorite | 万}} 收藏
- **链接**：{{meta.url}}

## 简介

{{meta.desc 截至前 ~300 字；无则写 "_（UP 主未填简介）_"}}

## 摘要

**一句话**：{{≤ 60 字的本期最浓缩定位}}

> 硬约束：这"一句话"必须可以从 `summary` 字段或 `meta.title` / `meta.desc` 直接
> 派生。**禁止**从 outline 的 part.content 推断"视频风格 / 情绪走向 / 叙事手法 /
> 配乐特点"等节目外解读。

{{
  如果 ai_summary.status=="ok" 且 summary 存在：
    直接使用 summary（官方 AI 总结），可略做语句打磨，不得新增节目外信息
  否则若 subtitle.status=="ok"：
    基于 content.txt 由模型写 1~2 段、≤ 300 字的中等长度摘要
  否则：
    "_暂无字幕和 AI 总结，只能基于标题/简介概述：…_"（≤ 100 字，明确标注信息不全）
}}

## 时间轴

> 时间戳来源优先级：`ai_summary.outline[].parts[].timestamp` > `meta.view_points[].from` > 无
> **禁止伪造时间戳**。无时间轴时按下方规则处理。

{{
  优先 ai_summary.outline：
    ### {{section.title}}
    - {{HH:MM:SS}}  {{part.content}}
    - ...
  其次 view_points：
    - {{HH:MM:SS}}  {{vp.content}}
  都无：
    _（本期无原生章节，也无 AI 总结时间轴）_
}}

## 要点

- 条数规则（**宁少勿多**，禁止凑数）：
    - 有字幕（`subtitle.status=="ok"`）：3~7 条都行，从 content.txt 里抽取关键句
    - 无字幕但有 AI 总结：条数 = `ai_summary.outline[*].parts[*]` 的**总数**，
      **最少 1 条、最多 5 条**。如果 outline 只有 3 个 parts，你就写 3 条要点，
      不要扩展到 5 条，更不要再加"总体风格/整体基调/意外感十足"这种主观条
    - 既无字幕也无 AI 总结：写 `_（信息不足以提炼要点）_`，**禁止**从 title / desc
      硬脑补
- 每条要点的**来源**硬性要求：
    - 必须能一一对应到 `meta.json` 的某个字段、`summary.json` 的某个 `part.content`、
      或 `content.txt` 的某一行。找不到出处就**直接删掉这条**，不要硬凑
    - 可以语句打磨（改词序、合并同义词），但**不得新增原料里没有的事实**
- **禁用词清单**（这些是"加戏"的典型信号，如果你的要点里出现其中之一，**删了
  这整条要点**，不要改）：
    - 主观评价：活跃 / 火爆 / 经典 / 独特 / 精彩 / 精巧 / 生动 / 深刻
    - 风格归纳：情感独白 / 文艺范 / 市井风 / 反差感 / 意外感 / 戏剧张力
    - 技术推断：BGM / 剪辑节奏 / 镜头语言 / 叙事结构（除非原料里明确出现这些词）
    - 情绪推断：从迷茫到释然 / 情绪基调 / 内心世界（除非 summary 原句出现这类词）
    - 数字评价：「7500+ 条评论」可以写，但加"活跃/热烈"就违规——只罗列数字不下判断

## 相关链接

- 视频：{{meta.url}}
- UP 主：https://space.bilibili.com/{{meta.owner.mid}}
- {{meta.desc 中出现的外部链接（如有）}}

---

<sub>由 bilibili-auto-md 自动整理。原料：`{{work_dir}}`。</sub>
```

### 内容硬规则

- 所有人名 / 数字 / 机构 / 引述都必须能在 `meta.json` / `summary.json` / `content.txt` 里找到出处，**不引入节目外知识**
- 中文引号统一用 `「」` / `『』`，**不要半角 `"`**
- 时间戳格式统一 `HH:MM:SS`（含 0 前缀）；`< 1 小时` 也写成 `00:MM:SS` 方便对齐，或统一写 `MM:SS`——整篇保持一致
- 播放 / 点赞 / 收藏数据用人类可读格式：`10000 → 1.0 万`，`100000000 → 1.0 亿`
- 如果 `ai_summary.status == "need_sessdata"` **且** `subtitle.status == "need_sessdata"`：
  **这种情况只能出现在用户明确拒绝登录的降级路径下**（Step 0 的默认路径会先完成
  扫码登录，此分支不该被触发）。在"摘要"一节**顶部**加一行：
  > `> ⚠️ 用户选择不登录 B 站，字幕和官方 AI 总结未获取。本 MD 只基于视频基础元数据；随时可以说「登录一下」重跑拿完整内容。`
- Markdown 不超过 3 级标题
- 不要在 md 里出现调试信息 / `<details>` / "由模型生成" 字样

## 输出 Schema（给上层 caller 的整个回复）

1. **完整 Markdown 文本**（用户要看的产物）
2. 一行确认：`已生成: <output_path>（X 字 / Y 个章节）`

不需要返回 JSON。上层 caller 直接用 `output_path` 作为 artifact。

## 失败回退

| 场景 | 行为 |
|---|---|
| pipeline 返回 `error`（网络/风控/找不到 BV） | 把 `error.message` 告诉用户，**不**产出 MD |
| `subtitle.status = need_sessdata` 且 `ai_summary.status = need_sessdata` | 凭证真的失效了。**先不写 MD**，调 `BilibiliAuthStatus(verify=true)` 确认后走扫码流程（Step 0），绑定成功再重跑 pipeline |
| **仅** `subtitle.status = need_sessdata`，`ai_summary` 正常 | 通常意味着 UP 主没开字幕（B 站返回 -101 也有这种歧义）。正常产出，"字幕节选"章节写 `_（本期未提供字幕）_` 即可，**不要**为此重登 |
| `subtitle.status = error` 且 `raw_code`/`raw_message` 非空 | 把具体错误码 + message 告诉用户（例如 `-412 风控`、`WBI signature 失败`）。**不要**静默产出带"⚠️"的降级 MD。让用户决定是重试还是先放过去 |
| `subtitle.status = need_sessdata` 且 `ai_summary.status = need_sessdata`（**用户已明确拒绝登录**） | 仍产出 MD，但顶部加警告行（见上方硬规则） |
| `subtitle.status = ok`、`ai_summary.status = empty` | 正常产出，摘要改由模型基于字幕写（B 站该视频暂无 AI 总结是常见情况） |
| `subtitle.status = empty`、`ai_summary.status = ok` | 正常产出，时间轴/要点基于官方 AI 总结；"字幕节选"相关内容跳过 |
| `subtitle.status = empty` 且 `ai_summary.status = empty` | 两边都没内容。产出 MD 但"要点"章节写 `_（信息不足以提炼要点，建议直接打开视频查看）_`；**禁止**从 title/desc 硬脑补要点 |
| `meta.desc` 空 / `view_points` 空 / `duration` 空 | 用 `_未标注_` / `_（本期无…）_` 占位，**绝不编造** |

## 禁用项

- ❌ 不要生成任何 `summary.json` / `outline.json`（pipeline 已生成，你只读不写）
- ❌ 不要调完 pipeline 之后又反复 `Read meta.json` 多次 —— 一次就够
- ❌ 不要把"对话正文"和"Write 文件"做成两份差异化产物。两者必须**完全等同**
  （一字不差）。**严禁**给对话版加 emoji 标题（📌 📖 🕐 🔑 等）、把列表改成表格、
  给章节小标题加粗、重排章节顺序、添加对话专用的介绍语 / 总结语。**贴给用户的
  版本 = 文件内容**，不是"文件内容 + 装饰"
- ❌ **不要先调 `BilibiliAuthStatus` 再调 `BilibiliLoginStart`**——LoginStart 已经
  自带 bound 检查；多调一次 AuthStatus 就是多浪费一个模型 round-trip
- ❌ **不要为本 skill 调用 `TaskCreate` / `TaskUpdate`**——这是个单步原子任务
  （Step 0~3 都在一个 agent loop 里跑完），跑任务面板纯属仪式，每次 Update 都
  要等模型 reasoning 一轮，白白多花几十秒
- ❌ 不要用正则 / 字符串扣 B 站网页来替代 `pipeline.py`——API 路径已经封装稳了
- ❌ 不要对无 AI 总结的视频硬编"伪时间轴"——缺就缺，明确标注
