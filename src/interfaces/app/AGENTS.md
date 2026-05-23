# App Client Notes

This package is the main Vite + React App client for Ripple. It is used directly as the browser client and embedded by the Tauri desktop/iOS/Android shells.

- Use `bun run dev` for local development on port `8820`.
- Use `bun run build` for TypeScript and production bundle verification.
- Use `bun run tauri:dev` for the Tauri desktop shell.
- Use `bun run tauri:ios:*` and `bun run tauri:android:*` for mobile Tauri packaging. The shells must keep using the same React client and must not introduce a second UI stack.
- Runtime API configuration uses `VITE_RIPPLE_API_URL`; when unset in development, the client calls `/v1` through the Vite proxy to `http://127.0.0.1:8810`; production builds fall back to `https://test-oauth.weilai.ai/v1`.
- Keep the app usable as a browser client. Tauri-specific behavior must be isolated behind `src/lib/platform/` so the web build remains first-class.
- Do not add server-only framework patterns, API routes, server actions, framework-specific auth flows, or local agent runtime logic here. The Ripple server remains outside this frontend package.
