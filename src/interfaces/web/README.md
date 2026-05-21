# Ripple Web

Ripple Web is a Vite + React single-page client for the Ripple server. The same client is also embedded by the Tauri desktop shell under `src-tauri/`.

## Development

```bash
bun install
bun run dev
```

The development server listens on:

```text
http://localhost:8820
```

In development, the client calls `/v1` on the Vite origin, and Vite proxies it to
`http://127.0.0.1:8810`. To point at another Ripple server, set:

```bash
VITE_RIPPLE_API_URL=http://localhost:8810/v1
```

Production builds without `VITE_RIPPLE_API_URL` fall back to
`https://test-oauth.weilai.ai/v1`.

## Tauri

The Tauri shell is frontend-only: it embeds this React client and still talks to an external Ripple server over `/v1`. It does not run the Python server or Codex runtime locally.

```bash
bun run tauri:dev
bun run tauri:build
```

On Linux, `tauri:build` includes AppImage packaging and may download Tauri's
AppImage helper tools. To verify the local desktop shell without that download,
build only the package formats that use local system dependencies:

```bash
bun run tauri:build:linux
```

Tauri requires a Rust stable toolchain. This package includes `src-tauri/rust-toolchain.toml` so Cargo uses `stable` for the shell without relying on a global default.

Platform-specific frontend behavior belongs in:

```text
src/lib/platform/
```

## Verification

```bash
bun src/lib/workbench.test.ts
bun src/lib/chatState.test.ts
bun src/lib/sessionPersistence.test.ts
bun src/lib/inputFocus.test.ts
bun run lint
bun run build
```
