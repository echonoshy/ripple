# Ripple Mobile

Expo/React Native mobile client for Ripple Server.

This package is the experimental chat-focused mobile client. The main iOS app
route for the full Ripple workbench is Tauri iOS; see
[`docs/IOS_TAURI.md`](../../../docs/IOS_TAURI.md).

This app is only a front-end caller. It does not run the agent loop, tools, sandbox, or backend locally. It talks to Ripple Server through the current `/v1` API.

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

For the full workbench/TestFlight route, use the Tauri iOS plan in
[`docs/IOS_TAURI.md`](../../../docs/IOS_TAURI.md). The commands below run this
Expo chat MVP client.

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

The same experimental chat client can run on Android.

```bash
npm run android
```

If the Ripple Server is only reachable through an `http://<ip>:<port>` URL, enable Android cleartext traffic for the local run:

```bash
RIPPLE_ANDROID_USES_CLEARTEXT=true npm run android
```

For an installable Android test APK while there is no HTTPS domain yet:

```bash
eas build --platform android --profile preview
```

The `production` EAS profile keeps Android cleartext traffic disabled and is intended for the later HTTPS-domain path.

## Verification

```bash
npm test
npm run typecheck
```
