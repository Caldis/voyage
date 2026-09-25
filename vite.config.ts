import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 5181 },
  // three.js 本身就有 600 kB 左右，不值得为它拆包
  build: { chunkSizeWarningLimit: 1000 },
});
