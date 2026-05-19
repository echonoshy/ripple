import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(dirname, "src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 8820,
    proxy: {
      "/v1": {
        target: "http://127.0.0.1:8810",
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 8820,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          katex: ["katex"],
          markdown: ["react-markdown", "rehype-highlight", "rehype-katex", "remark-gfm", "remark-math"],
          motion: ["framer-motion"],
          react: ["react", "react-dom"],
        },
      },
    },
  },
});
