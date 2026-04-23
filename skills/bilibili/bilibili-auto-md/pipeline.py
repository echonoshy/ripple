"""bilibili-auto-md 的薄封装。

调用 `bilibili-episode-extract/pipeline.py` 拉原料，再算好最终 md 的
`output_path`（/workspace/.outputs/bilibili/YYYY-MM-DD-<slug>.md），把两份
信息合起来返回给 SKILL 层。SKILL 层负责用 Read 读原料 + 写 Markdown + Write
落盘到 output_path。

遵循 podcast-auto-md 的设计：脚本不写 Markdown，模型在对话里写 Markdown 同时
用 Write 落盘——保证"对话里看到的"等于"磁盘上落盘的"。
"""

import argparse
import json
import pathlib
import re
import subprocess
import sys
import time

SANDBOX_OUTPUT_ROOT_DEFAULT = pathlib.Path("/workspace/.outputs/bilibili")
EXTRACT_SCRIPT = pathlib.Path(__file__).resolve().parent.parent / "bilibili-episode-extract" / "pipeline.py"


def slugify(title: str, max_len: int = 40) -> str:
    """标题 → 文件名 slug：保留中英数字和连字符，其它统一为 '-'。"""
    if not title:
        return "untitled"
    s = title.strip()
    # 非中文、非字母、非数字 -> '-'
    s = re.sub(r"[^\w\u4e00-\u9fff]+", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return (s[:max_len] or "untitled").rstrip("-")


def call_extract(
    args_dict: dict,
    work_root: pathlib.Path,
    sessdata_file: pathlib.Path,
) -> dict:
    cmd = [
        sys.executable,
        str(EXTRACT_SCRIPT),
        "--args",
        json.dumps(args_dict, ensure_ascii=False),
        "--work-root",
        str(work_root),
        "--sessdata-file",
        str(sessdata_file),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if proc.returncode != 0:
        # extract 脚本错误时 stdout 也是一行 JSON；优先解它
        try:
            return json.loads(proc.stdout)
        except Exception:
            raise RuntimeError(f"extract failed: rc={proc.returncode} stderr={proc.stderr}")
    return json.loads(proc.stdout)


def run(
    args_dict: dict,
    work_root: pathlib.Path,
    sessdata_file: pathlib.Path,
    output_root: pathlib.Path,
) -> dict:
    raw_output_dir = args_dict.pop("output_dir", None)
    extracted = call_extract(args_dict, work_root, sessdata_file)

    if "error" in extracted:
        return extracted

    title = extracted.get("title") or extracted.get("bvid") or "untitled"
    bvid = extracted.get("bvid")
    p = extracted.get("p", 1)
    date = time.strftime("%Y-%m-%d", time.localtime(extracted.get("pubdate") or time.time()))
    suffix = f"-p{p}" if p > 1 else ""
    filename = f"{date}-{bvid}{suffix}-{slugify(title)}.md"

    out_dir = pathlib.Path(raw_output_dir) if raw_output_dir else output_root
    out_dir.mkdir(parents=True, exist_ok=True)
    output_path = out_dir / filename

    return {
        **extracted,
        "output_path": str(output_path),
        "slug": slugify(title),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="bilibili-auto-md: prepare 阶段（调 extract + 算 output_path）")
    parser.add_argument("--args", required=True, help="转给 extract 的 JSON，可额外含 output_dir")
    parser.add_argument("--work-root", default="/workspace/.bilibili-work")
    parser.add_argument(
        "--sessdata-file",
        default="/workspace/.bilibili/sessdata.json",
        help="SESSDATA 持久化文件路径。默认 sessdata.json（扫码登录流程维护，"
        "含 sessdata/bili_jct/... 四件套）；也兼容旧的 sessdata.txt 纯文本格式。",
    )
    parser.add_argument("--output-root", default=str(SANDBOX_OUTPUT_ROOT_DEFAULT))
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
            output_root=pathlib.Path(opts.output_root),
        )
    except Exception as e:
        print(json.dumps({"error": str(e), "error_type": type(e).__name__}, ensure_ascii=False))
        sys.exit(1)

    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
