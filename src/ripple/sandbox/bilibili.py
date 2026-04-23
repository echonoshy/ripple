"""Bilibili SESSDATA 的 per-user 管理 + 扫码登录

与 notion.py 的关键差异：
  * B 站 Web 有官方**扫码登录**流程（不用用户自己开 F12 找 Cookie）：
      1. POST /x/passport-login/web/qrcode/generate → 返回 qrcode_key + 待扫 URL
      2. GET /x/passport-login/web/qrcode/poll?qrcode_key=xxx 每 2 秒轮询
      3. data.code == 0 时，data.url 的 query string 里直接带着
         SESSDATA / bili_jct / DedeUserID / Expires —— 解析出来存就行。
  * SESSDATA 不作为 env 注入，而是把整个 credentials/bilibili.json 以
    readonly bind-mount 挂进沙箱 `/workspace/.bilibili/sessdata.json`：
      - 多字段（sessdata、bili_jct、expires_at 等）一起传，脚本按需取。
      - env 明文在 /proc/<pid>/environ 里容易被同沙箱内进程看到，而
        bind-mount readonly 文件更贴近 "secret file" 模式。
  * 没有 JSON 时 pipeline.py 会走降级模式（只出 metadata，不拉字幕/总结）。

所有凭证访问都严格从 user 级文件读，**禁止**回落到任何全局配置；
这是项目对"每个 user 对应独立凭证"的硬约束。
"""

import base64
import io
import json
import urllib.error
import urllib.parse
import urllib.request

from ripple.sandbox.config import SandboxConfig
from ripple.utils.logger import get_logger

logger = get_logger("sandbox.bilibili")

# --- B 站官方 API 端点 ---
_QRCODE_GENERATE_URL = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate"
_QRCODE_POLL_URL = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll"
_NAV_URL = "https://api.bilibili.com/x/web-interface/nav"

# 冒充一个常见的浏览器 UA；不带 UA 时 B 站会直接拒绝返回 -412 / 412 码。
_DEFAULT_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
_DEFAULT_REFERER = "https://www.bilibili.com/"

# 扫码 poll 的状态码
QR_STATE_OK = 0
QR_STATE_EXPIRED = 86038
QR_STATE_NOT_CONFIRMED = 86090  # 已扫码未确认
QR_STATE_NOT_SCANNED = 86101  # 未扫码

# 扫码超时（秒）——B 站二维码服务端默认 3 分钟失效。
QRCODE_TTL_SECONDS = 180


# ---------- HTTP helpers ----------


def _http_get_json(url: str, *, timeout: float = 10.0) -> dict:
    """GET url + 默认 UA/Referer，返回 JSON dict。失败抛 urllib.error.URLError。"""
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": _DEFAULT_UA,
            "Referer": _DEFAULT_REFERER,
            "Accept": "application/json, text/plain, */*",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
    return json.loads(raw)


def _http_get_json_with_cookie(url: str, sessdata: str, *, timeout: float = 10.0) -> dict:
    """GET url 时附带 SESSDATA cookie，用于已登录接口（如 /nav）。"""
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": _DEFAULT_UA,
            "Referer": _DEFAULT_REFERER,
            "Accept": "application/json, text/plain, */*",
            "Cookie": f"SESSDATA={sessdata}",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
    return json.loads(raw)


# ---------- 凭证读写 ----------


def read_bilibili_credential(config: SandboxConfig, user_id: str) -> dict | None:
    """读取 user 级 Bilibili 凭证 JSON。

    返回字段示例:
        {
          "sessdata": "xxx",
          "bili_jct": "yyy",
          "dede_user_id": "12345",
          "uname": "某人",
          "mid": 12345,
          "bound_at": 1700000000,
          "expires_at": 1731536000
        }

    以下情况一律返回 None（不抛异常）：
      * 文件不存在 / 读取失败 / 不是 JSON object；
      * ``sessdata`` 字段缺失或为空白字符串；
      * ``expires_at > 0`` 且 ``expires_at <= now()``（即凭证已过期）——这是 v2
        新加的"软删除"：过期的 bilibili.json 保留在宿主磁盘上（方便回溯定位问题），
        但对 :class:`BilibiliAuthStatusTool` 等读侧调用呈现为"未绑定"，避免给 agent
        "bound=True + 后续 pipeline 401"的撕裂体验。要真正彻底清理可以调
        :func:`clear_bilibili_credential`。
    """
    import time  # noqa: PLC0415 —— 保持该模块 import 紧凑

    f = config.bilibili_config_file(user_id)
    if not f.exists():
        return None
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("user {} bilibili.json 读取失败: {}", user_id, e)
        return None
    if not isinstance(data, dict):
        return None
    sessdata = data.get("sessdata", "")
    if not isinstance(sessdata, str) or not sessdata.strip():
        return None

    # expires_at 0 / 缺失 → 视为无过期约束（某些历史凭证没有此字段）。
    expires_at = data.get("expires_at") or 0
    try:
        expires_at = int(expires_at)
    except (TypeError, ValueError):
        expires_at = 0
    if expires_at > 0 and expires_at <= int(time.time()):
        logger.info(
            "user {} bilibili.json 存在但 expires_at={} 已过期，按未绑定处理",
            user_id,
            expires_at,
        )
        return None
    return data


def write_bilibili_credential(config: SandboxConfig, user_id: str, credential: dict) -> None:
    """把 credential dict 原子写入 credentials/bilibili.json（宿主侧，chmod 600）。

    调用方（BilibiliLoginPollTool）负责保证 credential 中 sessdata 非空。
    """
    f = config.bilibili_config_file(user_id)
    f.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(credential, indent=2, ensure_ascii=False)
    tmp = f.with_suffix(".json.tmp")
    tmp.write_text(payload, encoding="utf-8")
    tmp.chmod(0o600)
    tmp.replace(f)
    logger.debug("写入 user {} bilibili.json", user_id)


def clear_bilibili_credential(config: SandboxConfig, user_id: str) -> bool:
    """删除 user 级凭证文件。返回是否真的删了。"""
    f = config.bilibili_config_file(user_id)
    if not f.exists():
        return False
    try:
        f.unlink()
    except OSError as e:
        logger.warning("user {} 删除 bilibili.json 失败: {}", user_id, e)
        return False
    logger.info("user {} bilibili.json 已删除（解绑）", user_id)
    return True


# ---------- 扫码登录核心 ----------


def qrcode_generate() -> dict:
    """调 B 站生成二维码接口。

    返回:
        {"qrcode_key": "xxx", "qrcode_content": "https://passport.bilibili.com/qrcode/h5/login?qrcode_key=xxx"}
    失败抛 RuntimeError。
    """
    try:
        resp = _http_get_json(_QRCODE_GENERATE_URL)
    except (urllib.error.URLError, json.JSONDecodeError, TimeoutError) as e:
        raise RuntimeError(f"调用 B 站生成二维码接口失败: {e}") from e
    if resp.get("code") != 0:
        raise RuntimeError(f"B 站生成二维码接口返回非 0: {resp}")
    data = resp.get("data") or {}
    qrcode_key = data.get("qrcode_key")
    qrcode_url = data.get("url")
    if not qrcode_key or not qrcode_url:
        raise RuntimeError(f"B 站生成二维码接口响应字段缺失: {resp}")
    return {"qrcode_key": qrcode_key, "qrcode_content": qrcode_url}


def qrcode_poll(qrcode_key: str) -> dict:
    """轮询二维码状态。

    返回统一结构:
        {
          "state": "ok" | "waiting_scan" | "scanned" | "expired" | "unknown",
          "raw_code": <int>,
          "raw_message": <str>,
          "credential_fields": {...}  # 仅 state=="ok" 时有
        }

    credential_fields 来自 data.url 的 query string，包含：
        sessdata, bili_jct, dede_user_id, dede_user_id_ck_md5, expires_at (unix ts)。

    网络失败抛 RuntimeError（上层应触发用户"稍后重试"）。
    """
    url = f"{_QRCODE_POLL_URL}?qrcode_key={urllib.parse.quote(qrcode_key, safe='')}"
    try:
        resp = _http_get_json(url, timeout=10.0)
    except (urllib.error.URLError, json.JSONDecodeError, TimeoutError) as e:
        raise RuntimeError(f"B 站轮询接口请求失败: {e}") from e

    data = resp.get("data") or {}
    raw_code = int(data.get("code", -1))
    raw_msg = str(data.get("message", ""))

    if raw_code == QR_STATE_OK:
        cross_url = data.get("url", "")
        fields = _parse_cookie_fields_from_crossdomain_url(cross_url)
        if not fields.get("sessdata"):
            return {
                "state": "unknown",
                "raw_code": raw_code,
                "raw_message": "状态码 0 但无法从 data.url 解析 SESSDATA",
            }
        return {
            "state": "ok",
            "raw_code": raw_code,
            "raw_message": raw_msg,
            "credential_fields": fields,
        }
    if raw_code == QR_STATE_NOT_SCANNED:
        return {"state": "waiting_scan", "raw_code": raw_code, "raw_message": raw_msg}
    if raw_code == QR_STATE_NOT_CONFIRMED:
        return {"state": "scanned", "raw_code": raw_code, "raw_message": raw_msg}
    if raw_code == QR_STATE_EXPIRED:
        return {"state": "expired", "raw_code": raw_code, "raw_message": raw_msg}
    return {"state": "unknown", "raw_code": raw_code, "raw_message": raw_msg}


def _parse_cookie_fields_from_crossdomain_url(url: str) -> dict:
    """从扫码成功后 data.url 的 query string 里抽 SESSDATA / bili_jct / DedeUserID / Expires。

    url 样例:
      https://passport.biligame.com/x/passport-login/web/crossDomain
          ?DedeUserID=12345
          &DedeUserID__ckMd5=xxx
          &Expires=1731536000
          &SESSDATA=a%2Cb%2Cc
          &bili_jct=yyy
          &gourl=https%3A%2F%2Fwww.bilibili.com%2F

    返回字段键一律 snake_case。Expires 是 unix 秒。url 里一般已经 URL-decoded 过一次
    （urllib parse_qsl 会再 decode 一次），输出的 sessdata 是原始未编码字符串——
    调脚本调用方若要作为 Cookie 使用需要时再 urllib.parse.quote。
    """
    if not url:
        return {}
    parsed = urllib.parse.urlparse(url)
    qs = urllib.parse.parse_qs(parsed.query)
    out: dict = {}

    def _one(k: str) -> str | None:
        vs = qs.get(k)
        return vs[0] if vs else None

    sess = _one("SESSDATA")
    if sess:
        out["sessdata"] = sess
    jct = _one("bili_jct")
    if jct:
        out["bili_jct"] = jct
    duid = _one("DedeUserID")
    if duid:
        out["dede_user_id"] = duid
    duid_md5 = _one("DedeUserID__ckMd5")
    if duid_md5:
        out["dede_user_id_ck_md5"] = duid_md5
    expires = _one("Expires")
    if expires:
        try:
            out["expires_at"] = int(expires)
        except ValueError:
            pass
    return out


def verify_credential_live(sessdata: str, *, timeout: float = 10.0) -> dict:
    """实时打 /x/web-interface/nav，返回 {"is_login": bool, "uname": str | None, "mid": int | None}。

    失败一律当"无法验证"处理（返回 is_login=False），不抛异常——扫码成功的瞬间
    有时 nav 接口还差半秒一致性，真实失败信息靠 raw_log 可辅助判断。
    """
    out: dict = {"is_login": False, "uname": None, "mid": None, "raw_log": None}
    try:
        resp = _http_get_json_with_cookie(_NAV_URL, sessdata, timeout=timeout)
    except (urllib.error.URLError, json.JSONDecodeError, TimeoutError) as e:
        out["raw_log"] = f"nav 请求失败: {e}"
        return out
    data = resp.get("data") or {}
    out["is_login"] = bool(data.get("isLogin"))
    uname = data.get("uname")
    if isinstance(uname, str) and uname:
        out["uname"] = uname
    mid = data.get("mid")
    if isinstance(mid, int) and mid > 0:
        out["mid"] = mid
    if not out["is_login"]:
        out["raw_log"] = f"nav 返回 isLogin=False (code={resp.get('code')})"
    return out


# ---------- 二维码渲染 ----------


def render_qrcode_png_bytes(content: str) -> bytes:
    """把 content 编码成 QR，返回原始 PNG 字节串（~1KB 量级）。

    用 segno（纯 Python，无 Pillow）生成，scale=8 时清晰度足够手机扫。
    """
    import segno  # noqa: PLC0415  延迟导入避免模块加载时付出代价

    qr = segno.make(content, error="m")
    buf = io.BytesIO()
    qr.save(buf, kind="png", scale=8, border=2)
    return buf.getvalue()


def render_qrcode_png_base64(content: str) -> str:
    """把 content 编码成 QR，返回 `data:image/png;base64,...` 形式的 Data URL。

    仅供不方便架 HTTP 路由的场景使用（如 CLI）。Web 场景推荐走
    `/v1/bilibili/qrcode.png?content=...` 路由，避免把 base64 塞进对话历史。
    """
    b64 = base64.b64encode(render_qrcode_png_bytes(content)).decode("ascii")
    return f"data:image/png;base64,{b64}"


# NOTE: 旧版这里有一个 render_qrcode_ascii() 把 QR 渲染成 Unicode 方块字符串返回
# 给 LLM，供 BilibiliLoginStart 在对话正文里贴一份"文本二维码"。实测在 Web UI 场景
# 里会往对话历史里灌 2000+ token 的字符块，每个后续 turn 都得付一遍 input cost，
# 而用户根本看不出那堆方块是二维码（浏览器里字体不等宽就彻底糊了）。v2 起统一只
# 给 `qrcode_image_url` 这条 PNG 路由链接，ASCII 渲染彻底下线。若未来有纯 CLI
# 场景需要，可以在 CLI 客户端侧用 segno 自行渲染。
