# Ripple Mobile

Expo/React Native mobile client for Ripple Server.

This app is only a front-end caller. It does not run the agent loop, tools, sandbox, or Python backend locally. It talks to the existing Ripple FastAPI server through the current `/v1` API.

## First Version Scope

- Configure server URL, API key, user id, model, and thinking mode.
- Create and switch sessions.
- Send chat messages to `POST /v1/chat/completions`.
- Render streamed assistant text when the runtime exposes a readable response stream.
- Show compact tool call summaries.
- Handle `AskUser` replies.
- Handle permission requests with allow once, always allow, and deny.
- Stop the current generation.

## Run On iOS

For a fuller command reference, including Release builds and CocoaPods/codegen notes, see [`docs/MOBILE_IOS.md`](../../../docs/MOBILE_IOS.md).
For recent mobile UI and Markdown rendering changes, see [`docs/MOBILE_APP_CHANGES.md`](../../../docs/MOBILE_APP_CHANGES.md).

From the repository root:

```bash
cd src/interfaces/mobile
npm install
npm run ios
```

`npm run ios` requires macOS with Xcode and an available iOS simulator or connected iPhone. On a physical phone, the server URL cannot be `localhost`; use a LAN IP, Tailscale address, Cloudflare Tunnel, or HTTPS domain that the phone can reach.

Examples:

```text
http://192.168.1.8:8810
https://ripple.example.com
```

The client automatically calls the `/v1` API under that base URL.

## Android

The same client can run on Android:

```bash
npm run android
```

## Verification

```bash
npm test
npm run typecheck
```
