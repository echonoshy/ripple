"""API Key 认证"""

from fastapi import HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from ripple.utils.config import get_config

_bearer_scheme = HTTPBearer(auto_error=False)


async def verify_api_key(
    credentials: HTTPAuthorizationCredentials | None = Security(_bearer_scheme),
) -> str:
    """校验 Bearer token，返回有效的 API key。

    配置中 api_keys 列表为空或未设置时跳过认证（开发模式）。
    """
    config = get_config()
    allowed_keys: list[str] = config.get("server.api_keys", []) or []

    if not allowed_keys:
        return "anonymous"

    if not credentials:
        raise HTTPException(status_code=401, detail="Missing Authorization header")

    if credentials.credentials not in allowed_keys:
        raise HTTPException(status_code=401, detail="Invalid API key")

    return credentials.credentials
