"""B 站单集预处理脚本。

一次调用完成：URL/BV/短链 → 统一 bvid → 拉视频基础元数据 →（有 SESSDATA 时）拉字幕
+ 官方 AI 总结 → 全部落盘到 `/workspace/.bilibili-work/<bvid>[-p<N>]/`。

纯 stdlib（urllib + hashlib），不依赖任何 pip 包，契合 nsjail 沙箱。WBI 签名
算法见 bilibili-shared/SKILL.md 引用的 API collect 文档。

输出（stdout 一行 JSON）：
    {
      "work_dir": "/workspace/.bilibili-work/<bvid>",
      "bvid": "...", "p": 1, "cid": 123,
      "title": "...", "owner": {...}, "duration": 213,
      "view_points": [...],            // 原生章节（若 UP 主做了）
      "subtitle": {
        "status": "ok|empty|need_sessdata|error",
        "lan": "zh-CN", "segments": 120, "file": "subtitle.json",
        "text_file": "content.txt"     // 仅 status=ok 时
      },
      "ai_summary": {
        "status": "ok|empty|need_sessdata|error",
        "summary": "...", "outline": [...], "file": "summary.json"
      }
    }
"""

import argparse
import hashlib
import json
import pathlib
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

SANDBOX_WORK_ROOT_DEFAULT = pathlib.Path("/workspace/.bilibili-work")
SANDBOX_SESSDATA_FILE_DEFAULT = pathlib.Path("/workspace/.bilibili/sessdata.json")
SANDBOX_SESSDATA_FILE_LEGACY = pathlib.Path("/workspace/.bilibili/sessdata.txt")

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"

# WBI 签名使用的重排映射表（B 站 Web 端硬编码值，全站通用）
MIXIN_KEY_ENC_TAB = [
    46,
    47,
    18,
    2,
    53,
    8,
    23,
    32,
    15,
    50,
    10,
    31,
    58,
    3,
    45,
    35,
    27,
    43,
    5,
    49,
    33,
    9,
    42,
    19,
    29,
    28,
    14,
    39,
    12,
    38,
    41,
    13,
    37,
    48,
    7,
    16,
    24,
    55,
    40,
    61,
    26,
    17,
    0,
    1,
    60,
    51,
    30,
    4,
    22,
    25,
    54,
    21,
    56,
    59,
    6,
    63,
    57,
    62,
    11,
    36,
    20,
    34,
    44,
    52,
]

BV_RE = re.compile(r"BV[0-9A-Za-z]{10}")


def build_opener(sessdata: str | None) -> urllib.request.OpenerDirector:
    """构造带 UA/Referer/Cookie 的 opener。"""
    headers = [
        ("User-Agent", UA),
        ("Referer", "https://www.bilibili.com"),
        ("Accept", "application/json, text/plain, */*"),
        ("Accept-Language", "zh-CN,zh;q=0.9"),
    ]
    if sessdata:
        headers.append(("Cookie", f"SESSDATA={sessdata}"))
    opener = urllib.request.build_opener()
    opener.addheaders = headers
    return opener


def http_get_json(opener: urllib.request.OpenerDirector, url: str, timeout: int = 15) -> dict:
    with opener.open(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def http_get_text(opener: urllib.request.OpenerDirector, url: str, timeout: int = 15) -> str:
    with opener.open(url, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


# ---------- 1. 输入解析：URL / BV / 短链 -> (bvid, p) ----------


def resolve_short_url(opener: urllib.request.OpenerDirector, url: str) -> str:
    """跟随 b23.tv 短链的 301。"""
    req = urllib.request.Request(url, headers=dict(opener.addheaders))
    with urllib.request.build_opener().open(req, timeout=10) as resp:
        return resp.geturl()


def parse_input(raw: str, opener: urllib.request.OpenerDirector) -> tuple[str, int]:
    """返回 (bvid, p)；p 从 URL 的 ?p=N 里抽，缺省 1。"""
    s = raw.strip()
    if not s:
        raise ValueError("empty input")

    if s.startswith("http") and "b23.tv" in s:
        s = resolve_short_url(opener, s)

    p = 1
    m_p = re.search(r"[?&]p=(\d+)", s)
    if m_p:
        p = int(m_p.group(1))

    m_bv = BV_RE.search(s)
    if not m_bv:
        raise ValueError(f"cannot find BV id in: {raw}")
    return m_bv.group(0), max(1, p)


# ---------- 2. WBI 签名 ----------


def get_wbi_keys(opener: urllib.request.OpenerDirector) -> tuple[str, str]:
    """从 /x/web-interface/nav 拿 img_key / sub_key。"""
    data = http_get_json(opener, "https://api.bilibili.com/x/web-interface/nav")
    wbi = data.get("data", {}).get("wbi_img", {})
    img_url = wbi.get("img_url", "")
    sub_url = wbi.get("sub_url", "")
    img_key = img_url.rsplit("/", 1)[-1].split(".")[0]
    sub_key = sub_url.rsplit("/", 1)[-1].split(".")[0]
    if not img_key or not sub_key:
        raise RuntimeError(f"wbi nav failed: {data}")
    return img_key, sub_key


def build_mixin_key(img_key: str, sub_key: str) -> str:
    raw = img_key + sub_key
    return "".join(raw[i] for i in MIXIN_KEY_ENC_TAB if i < len(raw))[:32]


def wbi_sign(params: dict, mixin_key: str) -> dict:
    """按 B 站规则给 params 加 wts + w_rid；返回新 dict（不改原参数）。"""
    signed = dict(params)
    signed["wts"] = int(time.time())
    sorted_items = sorted(signed.items())
    query = urllib.parse.urlencode(sorted_items, quote_via=urllib.parse.quote)
    signed["w_rid"] = hashlib.md5((query + mixin_key).encode("utf-8")).hexdigest()
    return signed


# ---------- 3. 视频基础元数据（/x/web-interface/view）----------


def fetch_video_view(opener: urllib.request.OpenerDirector, bvid: str) -> dict:
    data = http_get_json(
        opener,
        f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}",
    )
    if data.get("code") != 0:
        raise RuntimeError(f"view api failed: code={data.get('code')} msg={data.get('message')}")
    return data["data"]


def select_page_cid(view_data: dict, p: int) -> tuple[int, str]:
    """多 P 视频按 p（1-based）选对应 cid；单 P 直接用 view_data.cid。返回 (cid, part_title)。"""
    pages = view_data.get("pages") or []
    if not pages:
        return view_data["cid"], view_data.get("title", "")
    idx = min(max(p, 1), len(pages)) - 1
    page = pages[idx]
    return page["cid"], page.get("part") or view_data.get("title", "")


def extract_meta(view_data: dict, p: int, cid: int, part_title: str) -> dict:
    stat = view_data.get("stat") or {}
    owner = view_data.get("owner") or {}
    return {
        "bvid": view_data.get("bvid"),
        "aid": view_data.get("aid"),
        "p": p,
        "cid": cid,
        "title": view_data.get("title"),
        "part_title": part_title,
        "desc": view_data.get("desc"),
        "pubdate": view_data.get("pubdate"),
        "duration": view_data.get("duration"),
        "owner": {"mid": owner.get("mid"), "name": owner.get("name")},
        "tags": [],  # view 不带 tags，若将来要可另请求 /x/tag/archive/tags
        "stat": {k: stat.get(k) for k in ("view", "danmaku", "reply", "favorite", "coin", "share", "like")},
        "url": f"https://www.bilibili.com/video/{view_data.get('bvid')}" + (f"?p={p}" if p > 1 else ""),
    }


def extract_view_points(view_data: dict) -> list[dict]:
    """UP 主打的原生章节；单 P 时在顶层，多 P 时在 pages[i].view_points（暂按顶层拿）。"""
    vps = view_data.get("view_points") or []
    out = []
    for vp in vps:
        out.append(
            {
                "type": vp.get("type"),
                "from": vp.get("from"),
                "to": vp.get("to"),
                "content": vp.get("content"),
                "image_url": vp.get("imgUrl") or vp.get("img_url"),
            }
        )
    return out


# ---------- 4. 字幕（需 SESSDATA + WBI）----------


# B 站常见 code → 状态分类。保留 raw_code / raw_message 供上层排错。
#   -101 —— 账号未登录 / SESSDATA 失效
#   -400 —— 请求参数错误（bvid/cid 不匹配）
#   -404 —— 视频不存在 / 已删除
#   -352 / -412 —— 风控（UA / Cookie / 频控被挡）；HTTP 层的 412/352 也归这一类
_CODE_NEED_SESSDATA = {-101, -400}
_CODE_RISK_CONTROL = {-352, -412}
_HTTP_RISK_STATUS = {412, 352}


def _wbi_call(
    opener: urllib.request.OpenerDirector,
    base_url: str,
    params: dict,
    mixin_key: str,
) -> dict:
    """统一的 WBI 签名调用。

    把 ``HTTPError 412/352``（B 站风控偶尔会在 HTTP 层而不是 JSON code 里抛）伪装
    成一条假 JSON ``{"code": -412/-352, "message": "HTTP 412"}``，让上游统一按
    ``_CODE_RISK_CONTROL`` 走 mixin_key 重试逻辑。其它异常透传成 dict（带
    ``_exc`` 字段）便于上游兜底。
    """
    signed = wbi_sign(params, mixin_key)
    url = base_url + "?" + urllib.parse.urlencode(signed)
    try:
        return http_get_json(opener, url)
    except urllib.error.HTTPError as e:
        if e.code in _HTTP_RISK_STATUS:
            return {"code": -e.code, "message": f"HTTP {e.code}"}
        return {"code": None, "message": f"HTTP {e.code}", "_exc": e}
    except Exception as e:
        return {"code": None, "message": f"http request failed: {e}", "_exc": e}


def _call_with_risk_retry(
    opener: urllib.request.OpenerDirector,
    base_url: str,
    params: dict,
    mixin_key: str,
    refresh_mixin_key: "callable | None",
) -> dict:
    """先签一次；命中风控（JSON code 或 HTTP status）就刷新 mixin_key 再签一次。"""
    data = _wbi_call(opener, base_url, params, mixin_key)
    code = data.get("code")
    if code in _CODE_RISK_CONTROL and refresh_mixin_key is not None:
        try:
            new_mk = refresh_mixin_key()
        except Exception:
            new_mk = ""
        if new_mk and new_mk != mixin_key:
            data = _wbi_call(opener, base_url, params, new_mk)
    return data


def fetch_subtitle(
    opener: urllib.request.OpenerDirector,
    mixin_key: str,
    bvid: str,
    cid: int,
    refresh_mixin_key: "callable | None" = None,
) -> dict:
    """
    返回 {status, lan, lan_doc, segments, raw_code, raw_message}。
    status: ok | empty | need_sessdata | error。调用方负责判断 SESSDATA 是否存在。

    ``refresh_mixin_key`` 是一个可选回调 ``() -> str``：当首次请求返回风控状态码
    （-352 / -412 / HTTP 412）或 WBI 签名看起来可疑时，调用它拿一把新的
    mixin_key 再试一次。
    """
    data = _call_with_risk_retry(
        opener,
        "https://api.bilibili.com/x/player/wbi/v2",
        {"bvid": bvid, "cid": cid},
        mixin_key,
        refresh_mixin_key,
    )

    code = data.get("code")
    message = data.get("message", "")
    if "_exc" in data and code is None:
        return {
            "status": "error",
            "raw_code": None,
            "raw_message": message,
        }

    if code != 0:
        if code in _CODE_NEED_SESSDATA:
            return {
                "status": "need_sessdata",
                "raw_code": code,
                "raw_message": message,
            }
        return {
            "status": "error",
            "raw_code": code,
            "raw_message": message,
        }

    subtitles = (data.get("data") or {}).get("subtitle", {}).get("subtitles") or []
    if not subtitles:
        # 没字幕是很常见的情况（UP 主没开字幕），归类 empty 而非 error。
        return {"status": "empty", "raw_code": 0, "raw_message": message}

    # 优先级：UP 主上传的中文 > AI 自动中文 > 第一个
    def prio(s: dict) -> int:
        lan = s.get("lan") or ""
        if lan in ("zh-CN", "zh-Hans", "zh"):
            return 0
        if lan == "ai-zh":
            return 1
        if lan.startswith("en"):
            return 2
        return 3

    chosen = sorted(subtitles, key=prio)[0]
    sub_url = chosen.get("subtitle_url") or ""
    if sub_url.startswith("//"):
        sub_url = "https:" + sub_url
    if not sub_url:
        return {"status": "empty", "raw_code": 0, "raw_message": "subtitle_url empty"}

    try:
        raw = http_get_json(opener, sub_url)
    except Exception as e:
        return {
            "status": "error",
            "raw_code": 0,
            "raw_message": f"download subtitle failed: {e}",
        }

    segments = [
        {"from": item.get("from"), "to": item.get("to"), "content": item.get("content", "")}
        for item in raw.get("body", [])
    ]
    return {
        "status": "ok",
        "lan": chosen.get("lan"),
        "lan_doc": chosen.get("lan_doc"),
        "segments": segments,
        "raw_code": 0,
        "raw_message": message,
    }


# ---------- 5. 官方 AI 总结（需 SESSDATA + WBI）----------


def fetch_ai_summary(
    opener: urllib.request.OpenerDirector,
    mixin_key: str,
    bvid: str,
    cid: int,
    up_mid: int | None,
    refresh_mixin_key: "callable | None" = None,
) -> dict:
    """
    返回 {status, summary, outline, result_type, raw_code, raw_message}。
    status: ok | empty | need_sessdata | error。
    B 站的 code=1 = 暂未生成 AI 总结（常见于小 UP / 新视频），归类为 empty。
    """
    base: dict = {"bvid": bvid, "cid": cid}
    if up_mid:
        base["up_mid"] = up_mid

    data = _call_with_risk_retry(
        opener,
        "https://api.bilibili.com/x/web-interface/view/conclusion/get",
        base,
        mixin_key,
        refresh_mixin_key,
    )

    code = data.get("code")
    message = data.get("message", "")
    if "_exc" in data and code is None:
        return {
            "status": "error",
            "raw_code": None,
            "raw_message": message,
        }

    if code != 0:
        # code == 1：B 站侧"暂未生成 AI 总结"，属 empty 而非 error。
        if code == 1:
            return {
                "status": "empty",
                "raw_code": code,
                "raw_message": message,
                "result_type": None,
            }
        if code in _CODE_NEED_SESSDATA:
            return {
                "status": "need_sessdata",
                "raw_code": code,
                "raw_message": message,
            }
        return {
            "status": "error",
            "raw_code": code,
            "raw_message": message,
        }

    model_result = (data.get("data") or {}).get("model_result") or {}
    summary = model_result.get("summary")
    outline = model_result.get("outline") or []
    result_type = model_result.get("result_type")  # 0=无总结, 1=仅摘要, 2=总结+outline

    if not summary and not outline:
        return {
            "status": "empty",
            "raw_code": 0,
            "raw_message": message,
            "result_type": result_type,
        }

    clean_outline = []
    for sec in outline:
        parts = sec.get("part_outline") or []
        clean_outline.append(
            {
                "title": sec.get("title"),
                "timestamp": sec.get("timestamp"),
                "parts": [{"timestamp": p.get("timestamp"), "content": p.get("content")} for p in parts],
            }
        )
    return {
        "status": "ok",
        "result_type": result_type,
        "summary": summary,
        "outline": clean_outline,
        "raw_code": 0,
        "raw_message": message,
    }


# ---------- 6. 组装 content.txt（字幕纯文本，供 QA / 二次总结）----------


def segments_to_text(segments: list[dict]) -> str:
    """字幕合并为纯文本，每 8-15 秒一段换行，方便 LLM 分段处理。"""
    if not segments:
        return ""
    lines: list[str] = []
    buf: list[str] = []
    buf_start = segments[0].get("from", 0) or 0
    for seg in segments:
        start = seg.get("from") or 0
        content = (seg.get("content") or "").strip()
        if not content:
            continue
        buf.append(content)
        if (start - buf_start) >= 12 or len("".join(buf)) > 80:
            lines.append(f"[{format_ts(buf_start)}] " + " ".join(buf))
            buf = []
            buf_start = start
    if buf:
        lines.append(f"[{format_ts(buf_start)}] " + " ".join(buf))
    return "\n".join(lines)


def format_ts(seconds: float) -> str:
    s = int(seconds or 0)
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{sec:02d}" if h else f"{m:02d}:{sec:02d}"


# ---------- 7. 读 SESSDATA ----------


def _read_sessdata_from_path(p: pathlib.Path) -> str | None:
    """从文件路径中解析 SESSDATA；支持两种格式：

      * 后缀 .json / 首字符为 `{` 的 JSON 文件 —— 取 `sessdata` 字段（由 ripple
        后端 `BilibiliLoginPoll` 写入，随扫码登录流程维护）；
      * 纯文本文件 —— 整个内容就是 SESSDATA（旧模式，用户手动贴进来）。
    失败 / 内容无效返回 None。
    """
    if not p.exists():
        return None
    try:
        raw = p.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    if not raw:
        return None
    looks_json = p.suffix.lower() == ".json" or raw.startswith("{")
    if looks_json:
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return None
        if not isinstance(data, dict):
            return None
        val = data.get("sessdata", "")
        if isinstance(val, str) and val.strip():
            return val.strip()
        return None
    return raw


def load_sessdata(explicit: str | None, sessdata_file: pathlib.Path) -> tuple[str | None, str]:
    """返回 (sessdata, source)。source: 'arg' | 'file' | 'legacy' | 'none'。

    优先级：
      1. `explicit` 参数（CLI / JSON 里显式传的）
      2. 指定的 sessdata_file（通常是 bind-mount 进来的 JSON）
      3. 旧路径 `/workspace/.bilibili/sessdata.txt`（兼容用户手动贴的 TXT）
    """
    if explicit:
        return explicit.strip(), "arg"
    val = _read_sessdata_from_path(sessdata_file)
    if val:
        return val, "file"
    if sessdata_file != SANDBOX_SESSDATA_FILE_LEGACY:
        val = _read_sessdata_from_path(SANDBOX_SESSDATA_FILE_LEGACY)
        if val:
            return val, "legacy"
    return None, "none"


# ---------- 8. 主入口 ----------


def run(args_dict: dict, work_root: pathlib.Path, sessdata_file: pathlib.Path) -> dict:
    raw_input = args_dict.get("url") or args_dict.get("bvid") or args_dict.get("input") or ""
    if not raw_input:
        raise ValueError("need `url` or `bvid` in args")

    sessdata, sessdata_source = load_sessdata(args_dict.get("sessdata"), sessdata_file)
    opener = build_opener(sessdata)

    bvid, p = parse_input(raw_input, opener)

    view_data = fetch_video_view(opener, bvid)
    cid, part_title = select_page_cid(view_data, p)
    meta = extract_meta(view_data, p, cid, part_title)
    view_points = extract_view_points(view_data)

    suffix = f"-p{p}" if p > 1 else ""
    work_dir = work_root / f"{bvid}{suffix}"
    work_dir.mkdir(parents=True, exist_ok=True)

    subtitle_result: dict = {"status": "need_sessdata"} if not sessdata else {}
    summary_result: dict = {"status": "need_sessdata"} if not sessdata else {}

    if sessdata:
        try:
            img_key, sub_key = get_wbi_keys(opener)
            mixin_key = build_mixin_key(img_key, sub_key)
        except Exception as e:
            mixin_key = ""
            err = {"status": "error", "raw_code": None, "raw_message": f"wbi: {e}"}
            subtitle_result = dict(err)
            summary_result = dict(err)

        # 风控重试用回调：B 站偶尔会 -352/-412 把首次调用挡掉，重拉一把 mixin_key
        # 再试一次往往能过。封成 closure 是为了不让 fetch_* 依赖 opener 外的上下文。
        def _refresh_mixin_key() -> str:
            try:
                ik, sk = get_wbi_keys(opener)
                return build_mixin_key(ik, sk)
            except Exception:
                return ""

        if mixin_key:
            try:
                subtitle_result = fetch_subtitle(opener, mixin_key, bvid, cid, refresh_mixin_key=_refresh_mixin_key)
            except Exception as e:
                subtitle_result = {"status": "error", "raw_code": None, "raw_message": str(e)}
            try:
                summary_result = fetch_ai_summary(
                    opener,
                    mixin_key,
                    bvid,
                    cid,
                    meta["owner"].get("mid"),
                    refresh_mixin_key=_refresh_mixin_key,
                )
            except Exception as e:
                summary_result = {"status": "error", "raw_code": None, "raw_message": str(e)}

    # 落盘
    (work_dir / "meta.json").write_text(
        json.dumps({"meta": meta, "view_points": view_points}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (work_dir / "subtitle.json").write_text(json.dumps(subtitle_result, ensure_ascii=False, indent=2), encoding="utf-8")
    (work_dir / "summary.json").write_text(json.dumps(summary_result, ensure_ascii=False, indent=2), encoding="utf-8")

    content_file_rel: str | None = None
    if subtitle_result.get("status") == "ok":
        text = segments_to_text(subtitle_result.get("segments") or [])
        if text:
            (work_dir / "content.txt").write_text(text, encoding="utf-8")
            content_file_rel = "content.txt"

    # 精简返回给 SKILL 层
    return {
        "work_dir": str(work_dir),
        "bvid": bvid,
        "p": p,
        "cid": cid,
        "title": meta["title"],
        "part_title": meta["part_title"],
        "owner": meta["owner"],
        "duration": meta["duration"],
        "pubdate": meta["pubdate"],
        "url": meta["url"],
        "stat": meta["stat"],
        "view_points_count": len(view_points),
        "has_view_points": bool(view_points),
        "subtitle": {
            "status": subtitle_result.get("status"),
            "lan": subtitle_result.get("lan"),
            "segments": len(subtitle_result.get("segments") or []),
            "file": "subtitle.json",
            "text_file": content_file_rel,
        },
        "ai_summary": {
            "status": summary_result.get("status"),
            "has_summary": bool(summary_result.get("summary")),
            "outline_sections": len(summary_result.get("outline") or []),
            "file": "summary.json",
        },
        "sessdata_source": sessdata_source,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="B 站单集预处理：meta + 字幕 + 官方 AI 总结，全部落到 /workspace/.bilibili-work/<bvid>/"
    )
    parser.add_argument(
        "--args",
        required=True,
        help='JSON 参数字符串，如 \'{"url":"https://...","sessdata":"..."}\'',
    )
    parser.add_argument(
        "--work-root",
        default=str(SANDBOX_WORK_ROOT_DEFAULT),
        help="中间产物根目录，默认 /workspace/.bilibili-work；宿主测试可覆盖。",
    )
    parser.add_argument(
        "--sessdata-file",
        default=str(SANDBOX_SESSDATA_FILE_DEFAULT),
        help="SESSDATA 持久化文件路径，默认 /workspace/.bilibili/sessdata.json。"
        "脚本会根据后缀/首字符自动识别 JSON（取 sessdata 字段）或纯文本格式；"
        "文件不存在时自动回退到旧路径 /workspace/.bilibili/sessdata.txt 以兼容手贴场景。",
    )
    opts = parser.parse_args()

    try:
        args_dict = json.loads(opts.args)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"invalid --args JSON: {e}"}, ensure_ascii=False))
        sys.exit(2)

    try:
        result = run(
            args_dict,
            work_root=pathlib.Path(opts.work_root),
            sessdata_file=pathlib.Path(opts.sessdata_file),
        )
    except Exception as e:
        print(json.dumps({"error": str(e), "error_type": type(e).__name__}, ensure_ascii=False))
        sys.exit(1)

    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
