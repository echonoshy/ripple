"""测试 .ripple 路径常量"""

from ripple.utils import paths


def test_sandboxes_dir_is_under_ripple_home():
    assert paths.SANDBOXES_DIR == paths.RIPPLE_HOME / "sandboxes"


def test_legacy_sessions_dir_still_exported():
    # Phase 1 阶段两个常量共存，便于旧代码渐进迁移
    assert paths.SESSIONS_DIR == paths.RIPPLE_HOME / "sessions"


def test_sandboxes_cache_dir_unchanged():
    assert paths.SANDBOXES_CACHE_DIR == paths.RIPPLE_HOME / "sandboxes-cache"
