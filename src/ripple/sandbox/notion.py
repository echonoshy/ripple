"""Notion Integration Token 的 per-user 管理

与 feishu.py 的关键差异：
  * Notion 不走 OAuth，只需要一个 **Internal Integration Token** 字符串。
  * 因此没有"浏览器跳转 → 完成回调 → 写入 config.json"的流程，
    整个 ensure 逻辑简化为：读 credentials/notion.json → 拿 token。
  * 没有 token 时 **不** 在沙箱内启进程，只提示前端/模型通过
    `NotionTokenSet` 工具引导用户贴 token，落盘后下一轮自然生效。

所有 token 访问都严格从 user 级文件读，**禁止**回落到全局配置；
这是项目对"每个 user 对应独立凭证"的硬约束。
"""

import json

from ripple.sandbox.config import SandboxConfig
from ripple.utils.logger import get_logger

logger = get_logger("sandbox.notion")


def read_notion_token(config: SandboxConfig, user_id: str) -> str | None:
    """读取 user 级 Notion Integration Token。

    返回非空字符串或 None。读取失败（文件坏了 / 字段缺失）一律返回 None
    并记 warning，不抛异常——调用方（build_sandbox_env）会在 None 时
    跳过 env 注入，bash 守卫会在下一次命令前触发 [NOTION_AUTH_REQUIRED]。
    """
    f = config.notion_config_file(user_id)
    if not f.exists():
        return None
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("user {} notion.json 读取失败: {}", user_id, e)
        return None

    token = data.get("api_token", "")
    if not isinstance(token, str) or not token.strip():
        return None
    return token.strip()


def write_notion_token(config: SandboxConfig, user_id: str, api_token: str) -> None:
    """将 token 写入 sandbox_dir/credentials/notion.json（宿主侧，不入沙箱）。

    调用方（NotionTokenSetTool）负责：
      1. 校验 user_id 存在
      2. 校验 token 非空 / 前缀合理
      3. 确保 sandbox_dir 已创建

    本函数只做一件事：原子地落盘。
    """
    f = config.notion_config_file(user_id)
    f.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps({"api_token": api_token.strip()}, indent=2)
    f.write_text(payload, encoding="utf-8")
    f.chmod(0o600)
    logger.debug("写入 user {} notion.json", user_id)
