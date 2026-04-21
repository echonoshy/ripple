"""Podcast 流水线预处理脚本。

只做一件事：把一个播客 URL 抓下来，落成两份**给模型看的原料**：

- `meta.json`：标题、节目名、主播、嘉宾、时长、原始 outline（含时间戳）……
- `content.txt`：description + shownotes 去 HTML、去重后的纯文本

最终的 markdown 由模型直接写出（在对话里呈现 + 用 Write 工具落盘到 `output_path`），
脚本不再做任何"切片 / 渲染"的二次加工。这避免了"模型手写大块带中文引号 JSON"
的转义灾难，也让用户能在对话里直接看到产物。

输出一行 JSON 给上层 SKILL 用，字段：
  episode_id / work_dir / fetched / strategy / audio_url / output_path / slug / ...
"""

import argparse
import hashlib
import html
import json
import pathlib
import re
import sys
import urllib.parse
import urllib.request

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

# 都用仓库内目录:host 与 sandbox 双向可见(整个 ripple-dev 仓库被挂载进 sandbox).
# .podcast-work/ 是中间产物(meta.json + content.txt), .outputs/podcast/ 是最终 md.
_REPO_ROOT = pathlib.Path("/home/lake/workspace/wip/ripple-dev")
WORK_ROOT_DEFAULT = _REPO_ROOT / ".podcast-work"
OUTPUT_ROOT_DEFAULT = _REPO_ROOT / ".outputs" / "podcast"


def compute_episode_id(url: str, title: str) -> str:
    """根据 URL / title 生成稳定的 episode_id。"""
    if url:
        m = re.search(r"xiaoyuzhoufm\.com/episode/([0-9a-f]+)", url)
        if m:
            return m.group(1)
        m = re.search(r"[?&]i=(\d+)", url)
        if m:
            return "apple-" + m.group(1)
        return hashlib.sha1(url.encode("utf-8")).hexdigest()[:12]
    if title:
        return "t-" + hashlib.sha1(("title::" + title).encode("utf-8")).hexdigest()[:12]
    raise ValueError("need either url or title")


def clean_url(url: str) -> str:
    """去掉 utm_* 之类的跟踪参数。"""
    if not url:
        return url
    parsed = urllib.parse.urlparse(url)
    query_pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    kept = [(k, v) for k, v in query_pairs if not k.lower().startswith("utm_")]
    new_query = urllib.parse.urlencode(kept)
    return urllib.parse.urlunparse(parsed._replace(query=new_query))


def fetch_html(url: str, timeout: int = 20) -> str:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept-Language": "zh-CN,zh;q=0.9",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def parse_xiaoyuzhou(raw_html: str, episode_url: str) -> dict:
    """从小宇宙页面的 __NEXT_DATA__ 脚本里解析出 meta。"""
    m = re.search(
        r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>',
        raw_html,
        re.DOTALL,
    )
    if not m:
        return {
            "matched": False,
            "confidence": 0.2,
            "episode": {"episode_url": episode_url},
            "source": {"provider": "xiaoyuzhou", "url": episode_url},
            "notes": "页面未找到 __NEXT_DATA__，抽取失败",
        }

    data = json.loads(m.group(1))
    ep = (data.get("props") or {}).get("pageProps", {}).get("episode") or {}
    pod = ep.get("podcast") or {}

    outline = []
    shownotes = ep.get("shownotes") or ""
    for match in re.finditer(r'data-timestamp="(\d+)">([0-9:]+)</a>\s*([^<\n]+)', shownotes):
        outline.append(
            {
                "seconds": int(match.group(1)),
                "timestamp": match.group(2).strip(),
                "topic": match.group(3).strip(),
            }
        )

    hosts = extract_hosts_from_shownotes(shownotes)

    return {
        "matched": True,
        "confidence": 0.97,
        "episode": {
            "title": ep.get("title"),
            "podcast_name": pod.get("title"),
            "podcast_author": pod.get("author"),
            "hosts": hosts,
            "guests": [],
            "guest_profiles": [],
            "published_at": ep.get("pubDate"),
            "duration": ep.get("duration"),
            "episode_url": episode_url,
            "audio_url": (ep.get("enclosure") or {}).get("url") or ep.get("mediaKey"),
            "description": ep.get("description"),
            "shownotes": shownotes,
            "outline": outline,
        },
        "source": {"provider": "xiaoyuzhou", "url": episode_url},
        "notes": "meta 由 pipeline.py 自动落盘；hosts 为 shownotes 启发式提取",
    }


def extract_hosts_from_shownotes(shownotes_html: str) -> list[str]:
    """从 shownotes 中尝试抓 `🎙️主播：A、B` 这类字段。"""
    if not shownotes_html:
        return []
    plain = re.sub(r"<[^>]+>", "\n", shownotes_html)
    plain = html.unescape(plain)
    m = re.search(r"(?:主播|主讲|嘉宾主持)[：:]\s*([^\n|｜]+)", plain)
    if not m:
        return []
    raw = m.group(1)
    cut = re.split(
        r"[🎙🎵✂️🙋📮📖⚠️👀📚🔗🔖🎧🎤📬📺🌟]"
        r"|(?:音乐|剪辑|欢迎互动|邮箱|参考资料|声明)",
        raw,
        maxsplit=1,
    )
    raw = cut[0].strip()
    parts = re.split(r"[、,，/]+", raw)
    hosts = [p.strip() for p in parts if p.strip() and len(p.strip()) <= 12]
    return hosts[:5]


def build_content(meta: dict) -> str:
    """把 description 和 shownotes 去 HTML 后拼成 content.txt。

    description 往往是 shownotes 头部的复述，做一次去重。
    """
    ep = meta.get("episode") or {}
    description = (ep.get("description") or "").strip()
    shownotes_text = html.unescape(re.sub(r"<[^>]+>", "", ep.get("shownotes") or ""))
    shownotes_text = re.sub(r"\n{3,}", "\n\n", shownotes_text).strip()

    if description and shownotes_text.startswith(description[:80]):
        return shownotes_text
    if description and description in shownotes_text:
        return shownotes_text
    parts = [p for p in [description, shownotes_text] if p]
    return "\n\n".join(parts)


def decide_strategy(meta: dict, content: str) -> dict:
    ep = meta.get("episode") or {}
    text_chars = len(content)
    outline = ep.get("outline") or []
    audio_url = ep.get("audio_url")

    if text_chars >= 2000 and outline:
        strategy, quality = "text_only", "high"
    elif text_chars >= 1000:
        strategy, quality = "prefer_text_then_audio", "medium"
    elif audio_url:
        strategy, quality = "audio_only", "fallback"
    else:
        strategy, quality = "none", "none"

    return {
        "strategy": strategy,
        "text_chars": text_chars,
        "has_outline": bool(outline),
        "has_audio": bool(audio_url),
        "best_source_quality": quality,
    }


def slugify(title: str) -> str:
    """生成对文件系统 / URL 友好的文件名前缀。

    保留 CJK,去掉中英文标点 / emoji。
    """
    if not title:
        return "untitled"
    bad_chars = (
        r"\s/\\:*?\"<>|"
        r"、，。「」『』（）【】《》“”‘’：；！？·"
        r"—…"
    )
    keep = re.sub(f"[{bad_chars}]+", "-", title.strip())
    keep = re.sub(r"-+", "-", keep).strip("-")
    keep = keep[:60] or "untitled"
    if not re.search(r"[A-Za-z0-9\u4e00-\u9fff]", keep):
        keep = keep + "-" + hashlib.sha1(title.encode("utf-8")).hexdigest()[:8]
    return keep.lower()


def date_prefix(raw: str | None) -> str:
    """从 ISO 时间字符串里取 YYYY-MM-DD 前缀。"""
    if not raw:
        return ""
    m = re.match(r"(\d{4}-\d{2}-\d{2})", raw)
    return m.group(1) if m else ""


def build_output_path(meta: dict, output_root: pathlib.Path) -> pathlib.Path:
    ep = meta.get("episode") or {}
    title = ep.get("title") or "untitled"
    date = date_prefix(ep.get("published_at"))
    slug = slugify(title)
    name = f"{date}-{slug}.md" if date else f"{slug}.md"
    return output_root / name


def prepare(args: dict, work_root: pathlib.Path, output_root: pathlib.Path) -> dict:
    url = clean_url((args.get("episode_url") or "").strip())
    title = (args.get("title") or "").strip()
    output_root_arg = args.get("output_dir")
    if output_root_arg:
        output_root = pathlib.Path(output_root_arg)
    output_root.mkdir(parents=True, exist_ok=True)

    eid = compute_episode_id(url, title)
    work_dir = work_root / eid
    work_dir.mkdir(parents=True, exist_ok=True)

    result = {
        "episode_id": eid,
        "work_dir": str(work_dir),
        "fetched": False,
        "audio_url": None,
        "strategy": None,
        "output_path": None,
        "title": None,
        "podcast_name": None,
    }

    if not url:
        result["notes"] = "仅有 title，未抓取页面；上层应先调用 podcast-episode-resolve"
        return result

    provider = guess_provider(url)
    if provider != "xiaoyuzhou":
        meta = {
            "matched": False,
            "episode": {"episode_url": url, "title": title or url},
            "source": {"provider": provider, "url": url},
            "notes": "pipeline.py 未内置此平台解析，请手动 extract",
        }
        (work_dir / "meta.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        result["notes"] = f"provider={provider} 暂未内置解析，回退为只记录 URL"
        result["output_path"] = str(build_output_path(meta, output_root))
        return result

    raw_html = fetch_html(url)
    meta = parse_xiaoyuzhou(raw_html, url)
    (work_dir / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    content = build_content(meta)
    (work_dir / "content.txt").write_text(content, encoding="utf-8")

    strategy_info = decide_strategy(meta, content)
    output_path = build_output_path(meta, output_root)

    ep = meta.get("episode") or {}
    result.update(
        {
            "fetched": bool(meta.get("matched")),
            "audio_url": ep.get("audio_url"),
            "strategy": strategy_info["strategy"],
            "text_chars": strategy_info["text_chars"],
            "has_outline": strategy_info["has_outline"],
            "has_audio": strategy_info["has_audio"],
            "title": ep.get("title"),
            "podcast_name": ep.get("podcast_name"),
            "outline_sections": len(ep.get("outline") or []),
            "output_path": str(output_path),
        }
    )
    return result


def guess_provider(url: str) -> str:
    host = urllib.parse.urlparse(url).netloc.lower()
    if "xiaoyuzhoufm.com" in host:
        return "xiaoyuzhou"
    if "podcasts.apple.com" in host:
        return "apple-podcasts"
    return "page-extract"


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    ap_prepare = sub.add_parser(
        "prepare",
        help="抓取 + 落盘 meta/content + 计算 output_path",
    )
    ap_prepare.add_argument("--args", required=True, help="JSON: {episode_url?, title?, output_dir?}")
    ap_prepare.add_argument("--work-root", default=str(WORK_ROOT_DEFAULT))
    ap_prepare.add_argument("--output-root", default=str(OUTPUT_ROOT_DEFAULT))

    ns = ap.parse_args()

    if ns.cmd == "prepare":
        payload = json.loads(ns.args)
        result = prepare(
            payload,
            pathlib.Path(ns.work_root),
            pathlib.Path(ns.output_root),
        )
        print(json.dumps(result, ensure_ascii=False))
        return 0

    return 2


if __name__ == "__main__":
    sys.exit(main())
