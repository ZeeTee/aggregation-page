/**
 * 用 esbuild 把服务端打成单文件:`dist-server/index.js`。
 *
 * 产物只依赖 node 内置模块(生产零 npm 依赖),直接 `node dist-server/index.js` 启动。
 *
 *   node scripts/build-server.ts            # 构建一次
 *   node scripts/build-server.ts --watch    # 监听重建
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, context, type BuildOptions } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

const options: BuildOptions = {
  entryPoints: [resolve(root, 'server/index.ts')],
  outfile: resolve(root, 'dist-server/index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  // 只保留 node 内置模块为外部依赖;项目本身没有任何运行时 npm 依赖
  packages: 'external',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('[build-server] 监听中…');
} else {
  await build(options);
  console.log('[build-server] 已生成 dist-server/index.js');
}
