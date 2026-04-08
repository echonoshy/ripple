#!/bin/bash
# 启动 Ripple Web Client

cd "$(dirname "$0")/../web"
echo "🌊 Starting Ripple Web Client..."
bun run dev
