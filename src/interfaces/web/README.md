# Ripple Web

Ripple Web is a Vite + React single-page client for the Ripple server.

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

## Verification

```bash
bun src/lib/workbench.test.ts
bun src/lib/chatState.test.ts
bun src/lib/sessionPersistence.test.ts
bun src/lib/inputFocus.test.ts
bun run lint
bun run build
```
