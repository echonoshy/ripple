#!/usr/bin/env python3
"""Authorize shared ChatGPT/Codex credentials for Ripple.

This is an administrator-only helper. It performs the OpenAI Codex device-code
flow and writes one shared token file used by all Ripple users:

    .ripple/credentials/openai-codex.json
"""

import argparse
import asyncio
import sys
import time
import webbrowser
from datetime import datetime, timezone

from ripple.sandbox.config import SandboxConfig
from ripple.sandbox.openai_codex import (
    poll_device_login,
    read_shared_credentials,
    start_device_login,
    write_shared_credentials,
)
from ripple.utils.config import get_config


def _build_sandbox_config() -> SandboxConfig:
    config = get_config()
    config.openai_codex_credentials_mode("openai-codex")
    return SandboxConfig.from_dict(config.get("server.sandbox", {}) or {})


def _format_expiry(expires_ms: int) -> str:
    dt = datetime.fromtimestamp(expires_ms / 1000, tz=timezone.utc)
    return dt.isoformat(timespec="seconds")


def _print_status(config: SandboxConfig) -> None:
    credentials_file = config.openai_codex_shared_credentials_file()
    credentials = read_shared_credentials(config)
    print(f"credentials_file={credentials_file}")
    if credentials is None:
        print("status=missing")
        return
    print("status=present")
    print(f"access_expires_utc={_format_expiry(credentials.expires)}")


async def _authorize(args: argparse.Namespace) -> int:
    try:
        sandbox_config = _build_sandbox_config()
    except Exception as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 2

    credentials_file = sandbox_config.openai_codex_shared_credentials_file()

    if args.status:
        _print_status(sandbox_config)
        return 0

    if read_shared_credentials(sandbox_config) is not None and not args.force:
        print(f"Shared Codex credentials already exist: {credentials_file}")
        print("Use --force to run authorization again.")
        return 0

    login = await start_device_login()
    interval = args.interval_seconds or login.interval_seconds

    print("Open the verification URL and enter the code:")
    print(f"  URL:  {login.verification_url}")
    print(f"  Code: {login.user_code}")
    print()
    print("If ChatGPT asks you to enable device-code authorization for Codex,")
    print("open ChatGPT settings -> Security, enable it, then rerun this script.")
    print()
    print(f"Writing shared credentials to: {credentials_file}")

    if args.open_browser:
        webbrowser.open(login.verification_url, new=2)

    deadline = time.monotonic() + login.expires_in_seconds
    while time.monotonic() < deadline:
        credentials = await poll_device_login(login.device_auth_id, login.user_code)
        if credentials is not None:
            write_shared_credentials(sandbox_config, credentials)
            print("Authorization complete.")
            print(f"access_expires_utc={_format_expiry(credentials.expires)}")
            return 0
        print("Waiting for approval...")
        await asyncio.sleep(interval)

    print("Authorization timed out before approval completed.", file=sys.stderr)
    return 1


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Authorize shared ChatGPT/Codex credentials for Ripple.")
    parser.add_argument("--force", action="store_true", help="Run authorization even if shared credentials exist.")
    parser.add_argument("--status", action="store_true", help="Print shared credential status and exit.")
    parser.add_argument("--open-browser", action="store_true", help="Open the verification URL in a browser.")
    parser.add_argument(
        "--interval-seconds",
        type=int,
        default=None,
        help="Polling interval override. Defaults to the interval returned by OpenAI.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    try:
        return asyncio.run(_authorize(args))
    except KeyboardInterrupt:
        print("Authorization interrupted; no credentials were written.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
