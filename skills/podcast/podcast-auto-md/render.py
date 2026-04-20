"""Render podcast markdown from work_dir slot files.

读取 `<work_dir>` 下的 meta.json / summary.json / outline.json / keywords.json /
transcript.json（可选），套进 TEMPLATE.md，输出到 `<output_dir>` 下。

这个脚本是 podcast-auto-md 流水线的最后一步，用来替代"让模型在最后一个 turn
自由吐出整份 markdown"的做法——那种做法会让单 turn 的 SSE 输出超过 2 分钟，
被上游 provider 断流。
"""

import argparse
import datetime as dt
import hashlib
import html
import json
import re
import sys
from pathlib import Path

PLACEHOLDER = "_（本期缺失此项）_"


def _read_json(path: Path) -> dict | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"[render] warn: failed to parse {path}: {exc}", file=sys.stderr)
        return None


def _slugify(title: str) -> str:
    if not title:
        return "untitled"
    keep = re.sub(r"[\s/\\:*?\"<>|]+", "-", title.strip())
    keep = re.sub(r"-+", "-", keep).strip("-")
    keep = keep[:60] or "untitled"
    if not re.search(r"[A-Za-z0-9]", keep):
        keep = keep + "-" + hashlib.sha1(title.encode("utf-8")).hexdigest()[:8]
    return keep.lower()


def _fmt_list(items: list | None, bullet: str = "- ") -> str:
    if not items:
        return PLACEHOLDER
    lines = [f"{bullet}{str(x).strip()}" for x in items if str(x).strip()]
    return "\n".join(lines) if lines else PLACEHOLDER


def _fmt_outline(outline_json: dict | None) -> str:
    if not outline_json:
        return PLACEHOLDER
    sections = (outline_json.get("outline") or {}).get("sections") or []
    if not sections:
        return outline_json.get("notes") or "暂无时间轴"
    lines = []
    for s in sections:
        ts = (s.get("timestamp") or "").strip()
        topic = (s.get("title") or s.get("topic") or "").strip()
        summary = (s.get("summary") or "").strip()
        if ts and topic:
            if summary:
                lines.append(f"- `{ts}` {topic} —— {summary}")
            else:
                lines.append(f"- `{ts}` {topic}")
        elif topic:
            lines.append(f"- {topic}")
    return "\n".join(lines) if lines else "暂无时间轴"


def _fmt_highlights(items: list | None) -> str:
    if not items:
        return PLACEHOLDER
    lines = []
    for h in items:
        if isinstance(h, dict):
            term = (h.get("term") or "").strip()
            reason = (h.get("reason") or "").strip()
            if term and reason:
                lines.append(f"- **{term}** — {reason}")
            elif term:
                lines.append(f"- **{term}**")
        else:
            lines.append(f"- {h}")
    return "\n".join(lines) if lines else PLACEHOLDER


def _fmt_guests(guests: list | None, profiles: list | None) -> tuple[str, str]:
    gs = ", ".join([g for g in (guests or []) if g]) or PLACEHOLDER
    if not profiles:
        return gs, PLACEHOLDER
    lines = []
    for p in profiles:
        name = (p.get("name") or "").strip()
        title = (p.get("title") or "").strip()
        bio = (p.get("bio") or "").strip()
        seg = name
        if title:
            seg += f"（{title}）"
        if bio:
            seg += f"：{bio}"
        if seg:
            lines.append(f"- {seg}")
    return gs, "\n".join(lines) if lines else PLACEHOLDER


def _clean_html(s: str | None) -> str:
    if not s:
        return ""
    return html.unescape(re.sub(r"<[^>]+>", "", s)).strip()


def _render(template: str, mapping: dict[str, str]) -> str:
    out = template
    for k, v in mapping.items():
        out = out.replace("{{" + k + "}}", v if v is not None else PLACEHOLDER)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--work-dir", required=True)
    ap.add_argument("--template", required=True)
    ap.add_argument("--output-dir", required=True)
    ap.add_argument("--include-transcript", default="true")
    args = ap.parse_args()

    work_dir = Path(args.work_dir)
    if not work_dir.exists():
        print(json.dumps({"error": f"work_dir not found: {work_dir}"}))
        return 2

    meta = _read_json(work_dir / "meta.json") or {}
    summary = _read_json(work_dir / "summary.json")
    outline = _read_json(work_dir / "outline.json")
    keywords = _read_json(work_dir / "keywords.json")
    transcript = _read_json(work_dir / "transcript.json")

    ep = meta.get("episode") or {}
    src = meta.get("source") or {}

    title = ep.get("title") or "未命名播客"
    podcast_name = ep.get("podcast_name") or PLACEHOLDER
    hosts = ", ".join(ep.get("hosts") or []) or PLACEHOLDER
    guests_str, guest_profiles_str = _fmt_guests(ep.get("guests"), ep.get("guest_profiles"))
    episode_url = ep.get("episode_url") or PLACEHOLDER
    source_provider = src.get("provider") or PLACEHOLDER
    resolve_info = f"matched={meta.get('matched')}, confidence={meta.get('confidence')}" if meta else PLACEHOLDER
    description = _clean_html(ep.get("description")) or PLACEHOLDER

    s = (summary or {}).get("summary") or {}
    summary_short = s.get("short") or PLACEHOLDER
    summary_medium = s.get("medium") or PLACEHOLDER
    summary_bullets = _fmt_list(s.get("bullet_points"))

    outline_sections = _fmt_outline(outline)

    kw = (keywords or {}).get("keywords") or {}
    topics = _fmt_list(kw.get("topics"))
    entities = _fmt_list(kw.get("entities"))
    concepts = _fmt_list(kw.get("concepts"))
    highlights = _fmt_highlights(kw.get("highlights"))

    include_transcript = args.include_transcript.lower() in {"1", "true", "yes"}
    if transcript and include_transcript:
        tx = (transcript.get("transcript") or {}).get("text") or ""
        transcript_block = tx.strip() or "_（转写为空）_"
    elif transcript and not include_transcript:
        transcript_block = "_（已生成 transcript.json，为避免文件过大未内联，可在 work_dir 中查看）_"
    else:
        transcript_block = "_（本期未生成 transcript）_"

    sources_lines = []
    if episode_url and episode_url != PLACEHOLDER:
        sources_lines.append(f"- 原始链接：{episode_url}")
    if ep.get("audio_url"):
        sources_lines.append(f"- 音频：{ep.get('audio_url')}")
    sources = "\n".join(sources_lines) or PLACEHOLDER

    notes_parts = []
    if not summary:
        notes_parts.append("summary 缺失")
    if not outline:
        notes_parts.append("outline 缺失")
    if not keywords:
        notes_parts.append("keywords 缺失")
    if not transcript:
        notes_parts.append("transcript 缺失")
    notes = ("；".join(notes_parts) + "。") if notes_parts else "全部字段齐全。"

    template = Path(args.template).read_text(encoding="utf-8")
    md = _render(
        template,
        {
            "title": title,
            "podcast_name": podcast_name,
            "guests": guests_str,
            "guest_profiles": guest_profiles_str,
            "hosts": hosts,
            "episode_url": episode_url,
            "resolve_info": resolve_info,
            "source_provider": source_provider,
            "description": description,
            "summary_short": summary_short,
            "summary_medium": summary_medium,
            "summary_bullets": summary_bullets,
            "outline_sections": outline_sections,
            "topics": topics,
            "entities": entities,
            "concepts": concepts,
            "highlights": highlights,
            "transcript": transcript_block,
            "sources": sources,
            "notes": notes,
        },
    )

    published = ep.get("published_at") or ""
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", published)
    date = f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else dt.date.today().isoformat()
    file_name = f"{date}-{_slugify(title)}.md"

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    out_path = output_dir / file_name
    out_path.write_text(md, encoding="utf-8")

    print(
        json.dumps(
            {
                "markdown_path": str(out_path),
                "artifacts": {
                    "meta": bool(meta),
                    "summary": bool(summary),
                    "outline": bool(outline),
                    "keywords": bool(keywords),
                    "transcript": bool(transcript),
                },
                "notes": notes,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
