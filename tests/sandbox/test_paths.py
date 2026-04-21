"""测试 .ripple 路径常量"""

from ripple.utils import paths


def test_sandboxes_dir_is_under_ripple_home():
    assert paths.SANDBOXES_DIR == paths.RIPPLE_HOME / "sandboxes"


def test_sandboxes_cache_dir_unchanged():
    assert paths.SANDBOXES_CACHE_DIR == paths.RIPPLE_HOME / "sandboxes-cache"
