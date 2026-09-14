import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

import { scanTools } from './src/build/tools.ts';
import { toolsPlugin } from './src/build/tools-plugin.ts';

const root = fileURLToPath(new URL('.', import.meta.url));

// 开发期 API 端口避开仍在运行的 Python 版(8080);生产由 systemd 指定
const apiPort = process.env['API_PORT'] ?? '8090';

// 多页应用：门户页 + 每个 TS 工具的 index.html 各是一个独立入口
// （vanilla 工具不进 rollup，由 toolsPlugin 在写盘阶段整目录拷贝）
const { tsEntries } = scanTools(resolve(root, 'tools'));

export default defineConfig({
  plugins: [toolsPlugin()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: [resolve(root, 'index.html'), ...tsEntries],
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // 开发期把 /api 代理到 Node 服务,浏览器里始终是同源访问(与生产一致)
    proxy: { '/api': `http://127.0.0.1:${apiPort}` },
  },
  preview: {
    host: '127.0.0.1',
    port: 8081,
    strictPort: true,
  },
});
