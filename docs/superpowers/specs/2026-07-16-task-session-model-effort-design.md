# TaskSession model / effort 传递设计

## 目标

让 Via-Gateway TaskSession 接口与 Chat 接口使用同一套模型 preset 解析规则，避免把 `codex-medium` 之类的 preset 名称直接传给 Codex。

## 接口语义

- `POST /task-sessions` 接受可选 `model`、`effort`，并保存为会话默认值。
- `POST /task-sessions/{task_id}/messages` 接受可选 `model`、`effort`，只覆盖本次 TaskSpec 解析。
- `POST /task-sessions/{task_id}/confirm` 接受可选 `model`、`effort`，只覆盖本次执行。
- TaskSession 公共投影回显会话默认的 `model`、`effort`。

## 解析规则

模型选择顺序为本次请求、TaskSession 默认值、服务端 `default_model`。选出名称后统一调用 `AppConfig::resolve_model`，把 preset 映射为真实模型名。

effort 选择顺序为本次请求、TaskSession 默认值、选中 preset 的默认 `reasoning_effort`。因此显式 effort 始终优先，行为与 Chat 接口一致。

TaskSpec 解析和确认后的 Ripple 执行共用一个纯函数，避免两条链路再次分叉。

## 兼容性

所有字段均可选。旧调用方不传字段时仍使用服务端默认配置。只新增公共响应字段，不删除或改名现有字段。

## 测试

- preset 被解析为真实模型名，并继承 preset effort。
- 本次请求覆盖 TaskSession 默认配置。
- TaskSession 默认配置覆盖 preset effort。
- 没有任何输入时回落到服务默认 preset。
- 公共 TaskSession 投影回显 `model`、`effort`。
