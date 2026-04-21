"""user_id 合法性校验"""

import pytest

from ripple.sandbox.config import validate_user_id


def test_valid_user_ids():
    for uid in ["default", "user-123", "ABC_xyz", "a", "x" * 64]:
        assert validate_user_id(uid) == uid


def test_invalid_user_ids_raise():
    for uid in [
        "",
        " ",
        "user/../etc",
        "a/b",
        "x" * 65,
        "user name",
        "用户1",
        "user.name",
    ]:
        with pytest.raises(ValueError, match="Invalid user_id"):
            validate_user_id(uid)


def test_none_raises():
    with pytest.raises(ValueError):
        validate_user_id(None)  # type: ignore[arg-type]
