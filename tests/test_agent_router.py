from ripple.agent_runners.router import ExecutionRoute, choose_route


def test_routes_complex_coding_task_to_default_agent_runner():
    decision = choose_route("修复这个仓库里的 pytest 失败，并修改相关 Python 文件")

    assert decision.route == ExecutionRoute.AGENT_RUNNER
    assert decision.provider == "codex"
    assert "complex_task" in decision.signals


def test_routes_complex_privileged_skill_task_to_agent_runner():
    decision = choose_route("读取我的 Google Drive 文件，整理项目状态，并生成总结文档")

    assert decision.route == ExecutionRoute.AGENT_RUNNER
    assert decision.provider == "codex"
    assert "complex_task" in decision.signals


def test_scheduler_request_no_longer_routes_to_ripple_tools():
    decision = choose_route("明天上午 9 点提醒我开会")

    assert decision.route == ExecutionRoute.DIRECT
    assert decision.provider is None
    assert "basic_tool" not in decision.signals


def test_routes_simple_question_to_direct_answer():
    decision = choose_route("解释一下什么是 async await")

    assert decision.route == ExecutionRoute.DIRECT
    assert decision.provider is None


def test_explicit_provider_override_routes_to_codex_runner():
    decision = choose_route("帮我实现这个功能", explicit_provider="codex")

    assert decision.route == ExecutionRoute.AGENT_RUNNER
    assert decision.provider == "codex"
    assert "explicit_provider" in decision.signals
