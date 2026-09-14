/**
 * 部署冒烟:逐个 URL 断言状态码。
 *
 *   node scripts/smoke.ts              # 打本机 http://127.0.0.1:8080
 *   node scripts/smoke.ts --port 8081  # 换端口
 *   node scripts/smoke.ts --public     # 打线上 https://www.zeetng.cloud
 *
 * URL 列表来自构建产物 dist/tools.json(每个工具页都要能打开),外加首页与接口。
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const isPublic = args.includes('--public');
const portIndex = args.indexOf('--port');
const port = portIndex >= 0 ? args[portIndex + 1] : (process.env['PORT'] ?? '8080');
const base = isPublic ? 'https://www.zeetng.cloud' : `http://127.0.0.1:${port}`;

interface Check {
  path: string;
  /** 期望状态码;给数组表示"其中之一即可"(例如边缘与源站都拦时状态码不同) */
  expect: number | number[];
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

function toolPaths(): string[] {
  try {
    const payload = JSON.parse(readFileSync(join(root, 'dist', 'tools.json'), 'utf8')) as {
      tools?: Array<{ url?: string }>;
    };
    return (payload.tools ?? []).map((t) => t.url ?? '').filter((u) => u !== '');
  } catch {
    console.warn('!! 读不到 dist/tools.json,跳过工具页检查(先执行 npm run build)');
    return [];
  }
}

const checks: Check[] = [
  { path: '/', expect: 200 },
  { path: '/tools.json', expect: 200 },
  ...toolPaths().map((path) => ({ path, expect: 200 })),
  // 静态资源缓存策略
  { path: '/assets/base.css', expect: 200 },
  // 接口
  { path: '/api/health', expect: 200 },
  { path: '/api/tools', expect: 200 },
  { path: '/api/echo', expect: 405 }, // GET 不允许
  { path: '/api/echo', expect: 200, method: 'POST', body: '{"hello":"world"}', headers: { 'Content-Type': 'application/json' } },
  { path: '/api/echo', expect: 415, method: 'POST', body: 'hello', headers: { 'Content-Type': 'text/plain' } },
  { path: '/api/echo', expect: 400, method: 'POST', body: '{bad json', headers: { 'Content-Type': 'application/json' } },
  { path: '/api/nope', expect: 404 },
  // 安全:目录穿越必须被挡住
  // · /../ 会被 URL 解析器归一化成 /package.json → 404
  // · /%2e%2e%2f 是"段内编码斜杠",源站 resolveWithin 返回 403;
  //   走 Cloudflare 时边缘会先以 400 拦下(请求根本到不了源站),两者都算通过
  { path: '/../package.json', expect: 404 },
  { path: '/%2e%2e%2fpackage.json', expect: [403, 400] },
];

let failed = 0;
console.log(`>> 冒烟目标:${base}`);

for (const check of checks) {
  const method = check.method ?? 'GET';
  const expected = Array.isArray(check.expect) ? check.expect : [check.expect];
  let status: number | string = 'ERR';
  try {
    const response = await fetch(`${base}${check.path}`, {
      method,
      headers: check.headers,
      body: check.body,
      redirect: 'manual',
    });
    status = response.status;
    // 读取并丢弃响应体,避免连接悬挂
    await response.arrayBuffer();
  } catch (error) {
    status = `ERR ${(error as Error).message}`;
  }

  const pass = expected.includes(status as number);
  if (!pass) failed += 1;
  console.log(`   ${pass ? '✓' : '✗'} ${String(status).padStart(3)} (期望 ${expected.join(' / ')})  ${method} ${check.path}`);
}

console.log(failed === 0 ? `>> 全部通过(${checks.length} 项)` : `>> 失败 ${failed} / ${checks.length} 项`);
process.exit(failed === 0 ? 0 : 1);
