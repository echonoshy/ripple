import importlib.util
from pathlib import Path


def test_openai_codex_authorize_script_exists_for_shared_credentials():
    script = Path("scripts/authorize-openai-codex.py")

    assert script.exists()
    text = script.read_text(encoding="utf-8")
    assert "write_shared_credentials" in text
    assert "start_device_login" in text
    assert "poll_device_login" in text


def test_openai_codex_authorize_script_handles_keyboard_interrupt(monkeypatch, capsys):
    module = _load_authorize_script()

    def fake_run(coro):
        coro.close()
        raise KeyboardInterrupt

    monkeypatch.setattr(module.asyncio, "run", fake_run)

    exit_code = module.main([])

    captured = capsys.readouterr()
    assert exit_code == 130
    assert "Authorization interrupted" in captured.err
    assert "Traceback" not in captured.err


def _load_authorize_script():
    script = Path("scripts/authorize-openai-codex.py")
    spec = importlib.util.spec_from_file_location("authorize_openai_codex_script", script)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
