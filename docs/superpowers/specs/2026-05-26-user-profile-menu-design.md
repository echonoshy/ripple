# 用户身份卡片气泡菜单技术设计方案 (User Profile Popover Design)

## 1. 业务目标与需求 (Goal)
为了去除 `WorkspaceNav` 底部点击用户卡片唤起全局“设置模态框”所造成的功能重叠，我们将底部卡片升级为专门的用户身份及沙箱配置气泡菜单（Popover）。
菜单需要简洁、务实、富含极客与控制面平台的专业感：
1. **切换用户 (Switch User)**：允许在侧边栏内行内完成，避免繁琐的遮罩弹窗。
2. **配额与限制 (Quota & Usage)**：展示当前沙箱的磁盘用量（已用 / 最大容量）以及当前已创建会话数（已用 / 最大限制）。
3. **Token 使用量统计占位 (Token Usage)**：预留一个富有专业感的数据面板，展示大模型 Token 累计额度消耗等。

---

## 2. 后端 API 支持与扩展 (Backend API)

后端 Rust 已内置有成熟的 `user_usage` 计算函数（位于 `crates/ripple-server/src/api/users.rs`），返回包含 `workspace_size_bytes`、`session_count`、`runs_today`、`active_runs` 的 JSON 数据。
我们将直接升级 `/v1/users/me` 接口，以便前端在请求当前档案时同步拿回该沙箱下实时的用量配额。

### 2.1 路由变动
* **源文件**: `crates/ripple-server/src/api/users.rs`
* **功能变动**: 
  在 `current_user_profile` 异步方法中，获取 `user_usage` 并将其以 `usage` 字段作为响应的一部分进行返回。

```rust
pub async fn current_user_profile(
    State(state): State<AppState>,
    headers: HeaderMap,
    Extension(auth): Extension<AuthContext>,
) -> Result<Json<Value>, ApiError> {
    let user_id = user_id_from_headers(&headers).map_err(ApiError::bad_request)?;
    state.sandboxes.ensure_sandbox(&user_id)?;
    let usage = user_usage(&state, &user_id).await.unwrap_or(json!({}));
    Ok(Json(json!({
        "user_id": user_id,
        "auth": auth.public_json(),
        "usage": usage
    })))
}
```

---

## 3. 前端接口与状态流 (Frontend Integration)

### 3.1 前端 API 调用 (`app/src/lib/api.ts`)
新增 `fetchUserProfile` 函数：

```typescript
export async function fetchUserProfile(): Promise<{
  user_id: string;
  usage: {
    workspace_size_bytes: number;
    session_count: number;
    runs_today: number;
    active_runs: number;
  };
}> {
  const res = await fetch(`${API_URL}/users/me`, { headers: { ...authHeaders() } });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error("Failed to fetch user profile");
  return (await res.json()) as any;
}
```

### 3.2 侧边栏属性与状态
在 `WorkspaceNavProps` 接口中，剥离不需要的 Settings 调用，直接引入 `onUserIdChange`：

```typescript
interface WorkspaceNavProps {
  // ... 其他属性 ...
  userId: string;
  onUserIdChange: (newUserId: string) => void;
}
```

在 `WorkspaceNav` 组件中引入以下局部状态：
1. **`isUserMenuOpen: boolean`**：气泡菜单是否可见。
2. **`isSwitchingUser: boolean`**：当前底部是否正处于“切换账号”的输入状态。
3. **`newUserDraft: string`**：正输入的临时 User ID。
4. **`userUsageData: Usage | null`**：存储异步拉取到的 Quota 指标。

### 3.3 交互细节
* **打开气泡**：点击左下角头像区域，阻止冒泡，打开气泡并触发 `fetchUserProfile` 拉取最新配额数据。
* **点击空白关闭**：同 Session 列表遮罩，利用 Backdrop 在最外层支持点击外部关闭。
* **行内切换用户 (Switch User)**：
  * 点击“Switch User”，关闭气泡，设置 `isSwitchingUser(true)`，并将 input 的初始值设为 `userId`。
  * 头像卡片被一个精致的小输入框取代，内含“保存 (Check)”和“取消 (X)”按钮。
  * 失去焦点、按回车、点击保存按钮：触发 `onUserIdChange(newUserDraft)` 更改并清空状态。按 Esc、点击 X 取消。

---

## 4. UI 视觉设计 (Design Layout)

气泡菜单（Popover）容器位于底栏上方：
* 属性：`absolute bottom-14 left-3 z-50 w-64 rounded-xl border border-[#e5e7eb]/80 bg-white/95 backdrop-blur-md p-3.5 shadow-[0_12px_36px_-6px_rgba(0,0,0,0.1),0_4px_16px_rgba(0,0,0,0.04)]`。
* 内部布局：
  * **标题**：`Sandbox Status` 标签（带有呼吸绿色指示灯）。
  * **Quota 卡片**：
    * **Disk Usage**：展示以当前容量大小为基础的进度条。最大配额为 `2048 MB`（对齐 `users.rs` 中的 `max_workspace_mb: 2048`）。
    * **Active Sessions**：展示当前 Sessions 数量进度条。最大限制为 `200` 个（对齐 `users.rs` 中的 `MAX_SESSIONS_PER_USER: 200`）。
  * **Token Usage 占位**：
    * 带有银灰色卡片，显示 `Token usage (placeholder): ~k tokens` 以呈现纯正的 AI 平台控制面风格。
  * **操作动作**：底部设有一条细边线，下方提供 `Switch User` 文字链按钮。
