#!/bin/bash
# 启动 Ripple WebSocket Server

cd "$(dirname "$0")/.."
echo "🌊 Starting Ripple WebSocket Server..."
uv run python -m src.interfaces.server.app
