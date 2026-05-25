import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const tauriDevHost = process.env.TAURI_DEV_HOST;
const rippleIconPath = path.resolve(dirname, "../assets/ripple-icon.svg");
const rippleIconOutputPath = "assets/ripple-icon.svg";

function rippleIconAssetPlugin(): Plugin {
  return {
    name: "ripple-icon-asset",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const { pathname } = new URL(req.url ?? "/", "http://localhost");
        if (pathname !== `/${rippleIconOutputPath}`) {
          next();
          return;
        }

        let source: Buffer;
        try {
          source = fs.readFileSync(rippleIconPath);
        } catch (error) {
          next(error);
          return;
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", "image/svg+xml");
        res.end(source);
      });
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: rippleIconOutputPath,
        source: fs.readFileSync(rippleIconPath),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), rippleIconAssetPlugin()],
  clearScreen: false,
  resolve: {
    alias: {
      "@": path.resolve(dirname, "src"),
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  server: {
    host: tauriDevHost || "0.0.0.0",
    port: 8820,
    strictPort: true,
    hmr: tauriDevHost
      ? {
          protocol: "ws",
          host: tauriDevHost,
          port: 8821,
        }
      : undefined,
    proxy: {
      "/v1": {
        target: "http://127.0.0.1:8810",
        changeOrigin: true,
      },
    },
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 8820,
  },
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
    rollupOptions: {
      output: {
        manualChunks: {
          katex: ["katex"],
          markdown: [
            "react-markdown",
            "rehype-highlight",
            "rehype-katex",
            "remark-gfm",
            "remark-math",
          ],
          motion: ["framer-motion"],
          react: ["react", "react-dom"],
        },
      },
    },
  },
});
