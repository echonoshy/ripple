import importlib.util
from pathlib import Path

PIPELINE_PATH = Path(__file__).resolve().parents[1] / "skills/bilibili/bilibili-auto-md/pipeline.py"


def load_pipeline_module():
    spec = importlib.util.spec_from_file_location("bilibili_auto_md_pipeline", PIPELINE_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def extracted_without_sessdata() -> dict:
    return {
        "work_dir": "/workspace/.bilibili-work/BV1234567890",
        "bvid": "BV1234567890",
        "p": 1,
        "title": "测试视频",
        "pubdate": 1700000000,
        "subtitle": {"status": "need_sessdata"},
        "ai_summary": {"status": "need_sessdata"},
    }


def test_auto_md_blocks_output_path_when_auth_required(monkeypatch, tmp_path):
    pipeline = load_pipeline_module()
    monkeypatch.setattr(pipeline, "call_extract", lambda *_args, **_kwargs: extracted_without_sessdata())

    result = pipeline.run(
        {"url": "BV1234567890"},
        work_root=tmp_path / "work",
        sessdata_file=tmp_path / "missing.json",
        output_root=tmp_path / "outputs",
    )

    assert result["auth_required"] is True
    assert result["error"]["code"] == "bilibili_auth_required"
    assert "output_path" not in result


def test_auto_md_allows_metadata_output_after_explicit_opt_in(monkeypatch, tmp_path):
    pipeline = load_pipeline_module()
    monkeypatch.setattr(pipeline, "call_extract", lambda *_args, **_kwargs: extracted_without_sessdata())

    result = pipeline.run(
        {"url": "BV1234567890", "allow_unauthenticated": True},
        work_root=tmp_path / "work",
        sessdata_file=tmp_path / "missing.json",
        output_root=tmp_path / "outputs",
    )

    assert "error" not in result
    assert result["output_path"].endswith(".md")
