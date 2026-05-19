import json
from pathlib import Path

from ripple.utils.file_state import atomic_write_json, read_json_or_default, read_jsonl_tolerant


def test_atomic_write_json_leaves_existing_file_intact_on_serialization_error(tmp_path: Path):
    target = tmp_path / "state.json"
    target.write_text('{"ok": true}\n', encoding="utf-8")

    try:
        atomic_write_json(target, {"bad": object()})
    except TypeError:
        pass

    assert json.loads(target.read_text(encoding="utf-8")) == {"ok": True}
    assert not list(tmp_path.glob("*.tmp"))


def test_read_json_or_default_returns_default_for_corrupt_json(tmp_path: Path):
    target = tmp_path / "state.json"
    target.write_text("{not-json", encoding="utf-8")

    assert read_json_or_default(target, {"items": []}) == {"items": []}


def test_read_jsonl_tolerant_skips_bad_lines(tmp_path: Path):
    target = tmp_path / "events.jsonl"
    target.write_text('{"type":"a"}\n{bad-json\n\n{"type":"b"}\n', encoding="utf-8")

    assert read_jsonl_tolerant(target) == [{"type": "a"}, {"type": "b"}]
