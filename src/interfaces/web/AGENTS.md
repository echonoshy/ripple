# Web Frontend Notes

This frontend is a Vite + React single-page client for Ripple.

- Use `bun run dev` for local development on port `8820`.
- Use `bun run build` for TypeScript and production bundle verification.
- Runtime API configuration uses `VITE_RIPPLE_API_URL`; when unset, the client falls back to `http://<current-host>:8810/v1`.
- Keep this app as a browser client. Do not add server-only framework patterns, API routes, server actions, or framework-specific auth flows here.
