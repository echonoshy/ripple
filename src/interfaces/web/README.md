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

By default the client calls `http://<current-host>:8810/v1`. To point at another Ripple server, set:

```bash
VITE_RIPPLE_API_URL=http://localhost:8810/v1
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
