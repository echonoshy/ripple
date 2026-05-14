from pathlib import Path


def test_legacy_agent_loop_modules_are_removed():
    removed_paths = [
        "src/interfaces/server/sse.py",
        "src/ripple/core/agent_loop.py",
        "src/ripple/core/errors.py",
        "src/ripple/core/hooks.py",
        "src/ripple/core/query_params.py",
        "src/ripple/core/recovery.py",
        "src/ripple/core/state.py",
        "src/ripple/core/stop_hooks.py",
        "src/ripple/core/transitions.py",
        "src/ripple/compact",
        "src/ripple/api",
        "src/ripple/sandbox/openai_codex.py",
        "scripts/authorize-openai-codex.py",
    ]

    for path in removed_paths:
        assert not Path(path).exists(), f"legacy agent loop file should be removed: {path}"


def test_legacy_agent_loop_terms_are_not_used_in_runtime_source():
    forbidden_terms = (
        "agent_loop",
        "stop_agent_loop",
        "openai_codex_shared_credentials_file",
        "has_openai_codex_login",
    )
    source_roots = [Path("src/ripple"), Path("src/interfaces/server"), Path("src/interfaces/web/src")]
    offenders: list[str] = []

    for root in source_roots:
        for path in root.rglob("*"):
            if path.is_dir() or path.suffix not in {".py", ".ts", ".tsx", ".md"}:
                continue
            text = path.read_text(encoding="utf-8")
            for term in forbidden_terms:
                if term in text:
                    offenders.append(f"{path}:{term}")

    assert offenders == []
