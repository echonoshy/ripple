"""FastAPI 依赖：HTTP 请求头里提取 user_id 并校验。

通过 `X-Ripple-User-Id` header 传入。缺失时回落为 `default`；
不匹配 `^[a-zA-Z0-9_-]{1,64}$` 的取值一律 400 拒绝，防止路径遍历。
"""

from fastapi import Header, HTTPException

from ripple.sandbox.config import _USER_ID_RE


async def get_user_id(
    x_ripple_user_id: str | None = Header(default=None, alias="X-Ripple-User-Id"),
) -> str:
    """从 `X-Ripple-User-Id` header 解析 user_id。

    - header 缺失 → 返回 `"default"`
    - 非法字符（长度 / 字符集）→ 抛 400
    """
    uid = (x_ripple_user_id or "default").strip()
    if not _USER_ID_RE.match(uid):
        raise HTTPException(status_code=400, detail=f"Invalid X-Ripple-User-Id: {uid!r}")
    return uid
