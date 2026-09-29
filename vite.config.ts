import { defineConfig } from "vite";

// GitHub Pages 部署在子路径（https://caldis.github.io/voyage/）时，CI 传 VOYAGE_BASE=/voyage/；
// monorepo 内本地开发 / 构建不设这个变量，默认仍是根路径，行为不变。
const base = process.env.VOYAGE_BASE || "/";

export default defineConfig({
  base,
  server: { port: 5181 },
  // three.js 本身就有 600 kB 左右，不值得为它拆包
  build: { chunkSizeWarningLimit: 1000 },
});
