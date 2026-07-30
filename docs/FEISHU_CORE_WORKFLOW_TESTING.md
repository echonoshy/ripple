# 飞书核心工作流授权与测试

## 结论

Ripple 默认把授权拆成 `im`、`task`、`mail`、`docs` 四个独立 profile。用户第一次触发某一类飞书工作流时，只申请该基础流程对应的 **用户身份（UAT）**权限；同一个 profile 内会带齐完成流程所需的依赖权限。

| 场景 | Scope | 用途 |
| --- | --- | --- |
| 按姓名定位同事 | `contact:user:search` | 给同事发私信、分配任务前获取其 `open_id`。 |
| 获取当前用户身份 | `contact:user.basic_profile:readonly` | 创建任务前通过 `contact +get-user --as user` 获取当前授权用户信息。 |
| 发消息 | `im:message`、`im:message.send_as_user`、`im:chat:read` | 以当前授权用户的身份向已有会话或指定用户发消息，并支持按群名定位会话。 |
| 发邮件 | `mail:user_mailbox:readonly`、`mail:user_mailbox.message:send`、`mail:user_mailbox.message:modify` | `lark-cli mail +send` 先读取当前邮箱信息，再创建并发送草稿。 |
| 任务 | `task:task:write`、`task:tasklist:write` | 创建、更新任务及任务清单；写权限包含相应读取能力。 |
| 写飞书文档 | `docx:document:create`、`docx:document:readonly`、`docx:document:write_only` | 创建、读取、编辑用户有权访问的新版文档。 |

这组权限刻意不包括消息/邮件正文读取、云盘文件管理、多维表格、日历、通讯录组织架构等能力。它也不绕过资源自身 ACL：用户仍必须对目标群、文档或任务清单拥有访问权限。

部署管理员须先在飞书开发者后台为应用开通上述 **用户身份**权限，并完成需要的审批。用户按实际使用的基础流程分别授权；同一流程完成一次授权后不应在执行中途再次补权。已有的旧 token 必须重新授权才能获得新增 scope。

官方依据：飞书的[API 权限列表](https://open.feishu.cn/document/server-docs/application-scope/scope-list?lang=zh-CN)说明了消息、邮件、任务与 Docx scope；[发送消息 API](https://open.feishu.cn/document/server-docs/im-v1/message/create?lang=zh-CN)明确用户身份发送需要 `im:message` 和 `im:message.send_as_user`；[任务 API 概述](https://open.feishu.cn/document/task-v2/overview)说明任务和任务清单写权限；[用户搜索工具说明](https://open.feishu.cn/document/mcp_open_tools/developers-call-remote-mcp-server?lang=zh-CN)说明 `contact:user:search` 用于按姓名定位同事。

## 端到端测试

在服务端完成一次 Ripple 飞书授权后运行：

```bash
RIPPLE_USER_ID="test-user" \
RIPPLE_FEISHU_TEST_CHAT_ID="oc_xxx" \
bash scripts/test-feishu-core-workflows.sh im
```

默认模式会校验 token 是否包含所选 profile 的完整 scope，并为对应场景生成 dry-run 请求。场景参数支持 `im`、`task`、`mail`、`docs`；`all` 用于四个 profile 都已授权后的总体验收。

以下命令会真实发消息和邮件，并创建任务、任务清单和文档；只有在明确指定了测试会话和测试邮箱时执行：

```bash
RIPPLE_USER_ID="test-user" \
RIPPLE_FEISHU_TEST_CHAT_ID="oc_xxx" \
bash scripts/test-feishu-core-workflows.sh im --execute
```

脚本复用 `.ripple/sandboxes/<user>/credentials/lark-cli/` 下的当前用户凭证，不会发起授权、不读取或打印 token，也不会自动删除测试产物。若运行时根目录不是默认 `.ripple`，传入 `RIPPLE_RUNTIME_ROOT`；若凭证目录由部署方式单独指定，则直接设置三个 `LARKSUITE_CLI_*_DIR` 环境变量。
