---
name: bilibili-shared
description: B 站（bilibili）skill 的通用纪律：URL/BV 解析规则、扫码登录 4 工具、沙箱输出目录约定、鉴权降级策略。任何 bilibili-* 子 skill 首次被调用前必读。
when-to-use: 调用任何 bilibili-* skill（extract / auto-md / 后续子 skill）之前，只需读一次；不需要重复读。
---

# bilibili-shared

> 所有 `bilibili-*` 子 skill 共享的约定。**只读文档**，不产出任何文件。

## 一、输入形态统一

调用方可能传任意下面这种：

| 形态 | 示例 |
|---|---|
| 裸 BV 号 | `BV1GJ411x7h7` |
| 完整视频 URL | `https://www.bilibili.com/video/BV1GJ411x7h7/?spm_id_from=...` |
| 分 P URL | `https://www.bilibili.com/video/BV1GJ411x7h7?p=3` |
| 短链 | `https://b23.tv/xxxxxx` |

脚本内部统一解析成 `(bvid, p)` 二元组，`p` 默认 1。短链走一次 HEAD/GET 跟随 301 拿到真实 URL 再解析。禁止用"手动抠 BV"之外的脏套路。

## 二、SESSDATA（登录态）—— 走扫码登录，别让用户开 F12

B 站两个核心接口硬性要求登录态：

| 接口 | 需要 SESSDATA |
|---|---|
| `/x/web-interface/view`（视频基础元数据） | ❌ 不需要 |
| `/x/player/wbi/v2`（字幕） | ✅ 必须 |
| `/x/web-interface/view/conclusion/get`（AI 总结） | ✅ 必须 |

### 获取方式：用 4 个内置工具走"两段式扫码登录"（**唯一推荐路径**）

ripple 后端暴露了 4 个 per-user 隔离的内置工具，完成**全自动**扫码登录——用户
只需用 B 站 App 扫一下二维码就行，**不要**让用户开 F12 / 复制 Cookie。

| 工具 | 用途 |
|---|---|
| `BilibiliLoginStart` | **B 站登录的统一入口**。自带 bound 检查：已绑定→直接返回 `bound: True` + 身份字段；未绑定→申请新二维码并返回 `qrcode_key` + `qrcode_image_url`（HTTP 路由，点开就是可扫的 PNG）。**子 skill 默认调这一个就够**，不要先调 AuthStatus。 |
| `BilibiliLoginPoll` | 检查用户是否已扫码 + 点了确认登录。**短等待**（默认 30s）——用户说"好了"之后调，通常秒返回 `state=ok`；用户没点完确认则返回 `state=pending`，等下一 turn 再 poll |
| `BilibiliLogout` | 解绑（删宿主凭证 + 重生 nsjail.cfg）；B 站其他设备登录态不受影响 |
| `BilibiliAuthStatus` | 显式查询绑定状态。日常 pipeline **不需要**调用（LoginStart 已含 bound 检查）；只在以下两种场景用：①用户主动问"我绑的是哪个 B 站号 / 什么时候过期"；②pipeline 跑完出现 `need_sessdata`，调 `BilibiliAuthStatus(verify=true)` 二次确认凭证是否真失效 |

凭证落盘位置（**per-user 严格隔离**，每个 user 沙箱看不到别人的）：

- 宿主侧：`.ripple/sandboxes/<user_id>/credentials/bilibili.json`（`chmod 600`）
- 沙箱内：`/workspace/.bilibili/sessdata.json`（readonly bind-mount，只有
  `BilibiliLoginPoll` 成功后才存在）

### 需要 SESSDATA 时的标准流程（模型必须遵守）

> **核心纪律：两段式**。让用户扫码要**结束本 turn**，等他真正扫完 + 点确认后
> 再在下一 turn 里调 `BilibiliLoginPoll`。**绝对不要**在展示二维码的同 turn 里
> 立刻 poll——这会让对话挂在"处理中"几十秒，用户体验极差。

1. **直接调 `BilibiliLoginStart`**（不要先调 `BilibiliAuthStatus` 浪费一个
   round-trip——LoginStart 已含 bound 检查）。看返回的 `bound` 字段：

   - `bound=true` → 凭证已绑定且未过期。可看 `days_until_expiry`（≤ 7 时礼貌提
     醒续签），然后直接进正式流程。
   - `bound=false` → 工具已发了新二维码 + 把扫码闸门关上了，进入下面的扫码流程。

2. `bound=false` 分支：返回里关心三个字段：
   - **`qrcode_image_url`**（形如 `/v1/bilibili/qrcode.png?content=...`）——浏览器
     打开就是一张真正可扫的二维码 PNG。
   - **`qrcode_key`**：传给 `BilibiliLoginPoll` 用。
   - `qrcode_content`：⚠️ 那是 B 站**扫完之后**的落地 URL（浏览器打开只会看到
     "下载 B 站 App"提示页），**绝对不要**把它当成二维码链接给用户。
   ⚠️ **绝对禁止**在回复里贴 ASCII / Unicode 方块二维码——工具从 v2 起也不再
   返回该字段，这会往对话历史里灌 2000+ token 毫无用处的字符块。
3. **同一条回复（即本 turn 结尾）**里**只给用户两样东西**：
   - 一行 markdown 链接：`[点此查看扫码二维码](qrcode_image_url)`（让用户用 PC
     浏览器打开看到大图，再用手机 B 站 App 扫屏幕上的码）；
   - 一句指引：「请用 B 站 App 扫一扫 → 在 App 里点『确认登录』→ 扫完后**回我
     一句「好了」我再继续**」。
   然后**结束本 turn**——**不要**在本 turn 里调 `BilibiliLoginPoll`。
4. 用户在下一 turn 回覆「好了 / 扫好了 / ok / done / 点了确认登录」等字样后，
   **那一 turn 里**调 `BilibiliLoginPoll(qrcode_key=...)`：
   - state=`ok`      → 凭证已落盘；读 `uname` 向用户确认「已绑定 B 站账号 {uname}」，
     然后**重跑**之前被挡住的 pipeline。
   - state=`pending` + `last_state: "scanned"` → 用户扫了但没点确认登录。告诉他
     「扫到了，但还要在 B 站 App 里点一下『确认登录』。点完回我一句我重试。」
     然后**结束本 turn**，等他回话再 poll 一次。
   - state=`pending` + `last_state: "waiting_scan"` → 用户还没扫。告诉他「好像
     还没收到扫码——二维码还在那条链接里，麻烦扫一下，扫完回我。」然后**结束
     本 turn**，等他回话再 poll 一次。
   - state=`expired` → 告诉用户「二维码超时了，要不要重新生成？」得到同意再调
     `BilibiliLoginStart`；否则按用户意图收尾。
   - state=`timeout` → 同上（仅在 agent 显式传了较大 `max_wait_seconds` 时才会
     出现；默认 30s 短等待返回的是 `pending`）。
5. 若用户在任何阶段说「算了/不登录了/取消」，调 `BilibiliLogout` 解除闸门，
   然后按用户意图继续（或走降级路径）。

### 程序化 SESSDATA 读取的 3 级回退（供 `extract` 脚本内部用，不对用户暴露）

脚本按下列优先级读取，找到就用：

1. **JSON 参数 `sessdata`**（一次性，不落盘，主要用于开发调试）：
   ```json
   {"bvid": "BV1...", "sessdata": "abc..."}
   ```
2. **bind-mount JSON** `/workspace/.bilibili/sessdata.json`（扫码登录的产物；
   由后端维护，脚本只读；取其 `sessdata` 字段）。
3. 都没命中 → 脚本层**只**把字幕 / AI 总结字段置 `status: need_sessdata`
   返回，**不自动降级**出最终产物。上层 skill（auto-md 等）**默认**应该
   立刻调 `BilibiliLoginStart` 发起扫码——见下面「降级使用边界」。

### 降级使用边界（不是默认路径！）

绝大多数 bilibili 功能（auto-md、episode-qa 等）**默认**要求登录，因为没
字幕 / AI 总结的产出对用户价值很低（只剩标题+简介）。未绑定时的**默认行为
是立刻发起扫码流程**，而不是降级出残疾结果。

降级只在下面两种**用户显式表态**时才走：

1. 用户在对话里明说「不要登录 / 不用登录 / 别扫码 / 就用元数据 / 直接给我」等；
2. 扫码流程走完，用户主动说「算了 / 超时了不想再扫了」。

除此以外一律走扫码。**禁止**在未征求用户意见的情况下，自作主张产出一份带
「⚠️ 未登录」警告的残疾结果——这是糟糕 UX，违反本 skill 的纪律。

### 绝对禁止

- 让用户"打开 DevTools → Application → Cookies 找 SESSDATA 贴进来"——扫码
  已经彻底解决这个问题。
- 在对话里回显完整 SESSDATA / `bili_jct`（工具响应已经主动脱敏）。
- 通过 `bash` 直接写 `/workspace/.bilibili/sessdata.json` —— 沙箱内这个路径是
  readonly bind-mount，写不进；凭证必须走 `BilibiliLoginPoll` 的宿主侧写入通道。

## 三、沙箱输出目录约定（和 podcast 样板对齐）

`/workspace/` 是 nsjail 沙箱内唯一可写位置（宿主侧对应 `.ripple/sandboxes/<uid>/workspace/`）。

| 路径 | 读写 | 用途 |
|---|---|---|
| `/workspace/.bilibili/sessdata.json` | **ro** | 扫码登录凭证（后端 bind-mount 挂入；脚本只读） |
| `/workspace/.bilibili-work/<bvid>/` | rw | `extract` 脚本的中间产物（`meta.json`、`subtitle.json`、`summary.json`、`content.txt`） |
| `/workspace/.outputs/bilibili/YYYY-MM-DD-<slug>.md` | rw | `auto-md` 最终落盘的 Markdown |

多 P 视频的中间产物目录改为 `<bvid>-p<N>`（比如 `BV1xxx-p3`），避免不同分 P 互相覆盖。

## 四、鉴权 + 签名纪律

- **WBI 签名**由 `extract` 脚本自己算：从 `https://api.bilibili.com/x/web-interface/nav` 拿 `img_key` / `sub_key`（每日刷新），按 `MIXIN_KEY_ENC_TAB` 重排取前 32 位得 `mixin_key`，参数加 `wts` 后按 key 升序拼接 + MD5 = `w_rid`。算法稳定，**纯本地**。
- **User-Agent** 一律用普通桌面 Chrome UA；**Referer** 固定 `https://www.bilibili.com`；Cookie 只带 `SESSDATA` 一个字段就够（别把整串浏览器 Cookie 贴进来）。
- **风控退避**：脚本只做一次"刷 mixin_key 重试"——既覆盖 JSON `code: -352/-412`
  也覆盖 HTTP 层的 `412/352`（B 站偶尔走这条）。重试仍失败就把 `code` /
  `message` 透传给上层，**不做指数退避**——高频重试只会让 ban 更久。
- **失败可见性策略（给上层 skill）**：`subtitle.status` / `ai_summary.status`
  出现 `error` 时，**面向终端用户的产出（如 auto-md 的 Markdown）应该静默按
  "无字幕 / 无 AI 总结" 处理**——普通用户对 `-412 风控` 之类的术语既看不懂也
  没办法解决，写出去只会像出 bug。详细错误码已经落在 `subtitle.json` /
  `summary.json` 的 `raw_code` / `raw_message` 里供开发者排查。

## 五、MD 输出统一风格（供 `bilibili-auto-md` 参考）

- 中文引号一律用 `「」` / `『』`，**不要半角 `"`**（转义陷阱）
- 时间轴直接复用 B 站的 `view_points[]` 或 AI 总结 `outline[].part_outline[]`，**禁止伪造时间戳**
- 标题 + 章节 + 摘要（优先官方 AI 总结，缺失时基于字幕由模型总结）+ 字幕节选
- 字幕全文体量可能很大，`auto-md` 落盘时只嵌入精简版（按章节切段，每段 1-2 句代表），**完整字幕保留在 `/workspace/.bilibili-work/<bvid>/content.txt`** 供 QA 类 skill 再读

## 六、失败模式清单

| 现象 | 原因 | 处理 |
|---|---|---|
| `code: -352` / `-412` 或 HTTP `412` / `352` | 风控（Cookie 被 ban 或 UA 异常） | 脚本会自动刷 mixin_key 重试一次；仍失败时上层应**静默降级**（按"无字幕"产出 MD），不要把错误码暴露给终端用户。开发者可看 `subtitle.json` / `summary.json` 排查；持续被 ban 时考虑 `BilibiliLogout` + `BilibiliLoginStart` 重扫码 |
| `code: -101` | 未登录 / SESSDATA 失效 | 调 `BilibiliAuthStatus(verify=true)` 确认；若 `validated=false` 就重扫码 |
| 字幕 `subtitles: []` | 该视频未开启字幕 / 需要登录 | 有 SESSDATA 仍空就是真的没有 |
| AI 总结返回 `code: 0` 但 `model_result` 空 | 该视频暂未生成 AI 总结（常见于小 UP、新视频） | `auto-md` 降级为基于字幕让模型总结 |
| 扫码 poll 返回 state=`expired` | 二维码 3 分钟失效 | 告诉用户超时 + 调 `BilibiliLoginStart` 取新码 |
