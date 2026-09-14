import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

import { scanTools } from './src/build/tools.ts';
import { toolsPlugin } from './src/build/tools-plugin.ts';

const root = fileURLToPath(new URL('.', import.meta.url));

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
  },
  preview: {
    host: '127.0.0.1',
    port: 8081,
    strictPort: true,
  },
});
