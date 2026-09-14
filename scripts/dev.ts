/**
 * 开发模式:同时起 Vite(HMR,5173)与 Node API 服务(8090)。
 *
 * Vite 会把 /api 代理到 API 服务(vite.config.ts 读取 API_PORT),
 * 所以浏览器里始终是同源访问,和生产一致。
 *
 * 注意:开发期 API 端口默认 8090,避开仍在运行的 Python 版(8080);
 * 正式上线时 Node 服务监听 8080(见 deploy/aggregation-page.service)。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiPort = process.env['API_PORT'] ?? '8090';

const viteBin = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
if (!existsSync(viteBin)) {
  console.error('找不到 vite,请先执行 npm install');
  process.exit(1);
}

const children: ChildProcess[] = [
  spawn(process.execPath, ['--watch', 'server/index.ts'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, PORT: apiPort, HOST: '127.0.0.1', LOG_LEVEL: process.env['LOG_LEVEL'] ?? 'debug' },
  }),
  spawn(process.execPath, [viteBin], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, API_PORT: apiPort },
  }),
];

console.log(`>> 开发模式:前端 http://127.0.0.1:5173  |  API http://127.0.0.1:${apiPort}`);

let closing = false;
function shutdown(code = 0): void {
  if (closing) return;
  closing = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 300).unref();
}

for (const child of children) {
  child.on('exit', (code) => {
    if (!closing) {
      console.log(`>> 子进程退出(code=${code}),一并退出`);
      shutdown(code ?? 0);
    }
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
