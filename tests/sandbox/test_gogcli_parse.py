"""Tests for parsing `gog auth list --json` output."""

import json

import pytest

from ripple.sandbox.gogcli import parse_auth_list_output


def test_parse_empty_list():
    assert parse_auth_list_output('{"accounts":[]}') == []


def test_parse_single_account_without_check():
    raw = json.dumps({"accounts": [{"email": "alice@gmail.com"}]})
    got = parse_auth_list_output(raw)
    assert got == [{"email": "alice@gmail.com", "alias": None, "valid": None}]


def test_parse_with_alias_and_check():
    raw = json.dumps(
        {
            "accounts": [
                {"email": "alice@x.com", "alias": "work", "valid": True},
                {"email": "bob@y.com", "alias": None, "valid": False},
            ]
        }
    )
    got = parse_auth_list_output(raw)
    assert got == [
        {"email": "alice@x.com", "alias": "work", "valid": True},
        {"email": "bob@y.com", "alias": None, "valid": False},
    ]


def test_parse_top_level_list_variant():
    """某些 gog 版本可能直接返回一个数组，不是 {accounts:[...]} 包裹。"""
    raw = json.dumps([{"email": "a@b.com"}])
    got = parse_auth_list_output(raw)
    assert got == [{"email": "a@b.com", "alias": None, "valid": None}]


def test_parse_ignores_entries_without_email():
    raw = json.dumps({"accounts": [{"foo": "bar"}, {"email": "ok@x.com"}]})
    got = parse_auth_list_output(raw)
    assert got == [{"email": "ok@x.com", "alias": None, "valid": None}]


def test_parse_invalid_json_raises():
    with pytest.raises(ValueError):
        parse_auth_list_output("not-json")


def test_parse_bool_coercion():
    """valid 字段可能是 'true'/'false' 字符串（gog 版本差异兜底）。"""
    raw = json.dumps({"accounts": [{"email": "a@b.com", "valid": "true"}]})
    got = parse_auth_list_output(raw)
    assert got[0]["valid"] is True
