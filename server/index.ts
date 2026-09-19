#!/usr/bin/env node
/**
 * aggregation-page 服务端入口。
 *
 * 职责:读环境 → 校验产物 → 组装服务(AppOptions)→ 监听 → 处理信号。
 * HTTP 细节都在 server/app.ts,便于单测。
 *
 * 设计要点:
 *   · 只监听 127.0.0.1 —— 公网访问由 Cloudflare 隧道负责,不直接暴露端口
 *   · 启动时校验 dist/ 存在,缺失直接退出(避免"空站"上线)
 *   · 日志为 JSON lines,由 journald 收集
 *   · SIGTERM 优雅退出:停止接收新连接 → 等在途请求(最多 5s)
 *
 * 本地调试: PORT=8081 node server/index.ts
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from './app.ts';
import { loadEnvFile, readServerEnv } from './env.ts';
import { createLogger } from './log.ts';

/** 项目根目录:dev(server/index.ts)与产物(dist-server/index.js)都在根目录下一层 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

loadEnvFile(join(root, '.env'));
const env = readServerEnv(root);
const log = createLogger(env.logLevel);

if (!existsSync(env.distDir)) {
  log.error('站点目录不存在,拒绝启动(请先执行 npm run build)', { distDir: env.distDir });
  process.exit(1);
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** 读 tools.json 的工具数量(带 mtime 缓存,构建后自动失效) */
function makeToolsCounter(distDir: string): () => number {
  let cache: { mtimeMs: number; count: number } | undefined;
  return () => {
    try {
      const file = join(distDir, 'tools.json');
      const mtimeMs = statSync(file).mtimeMs;
      if (cache === undefined || cache.mtimeMs !== mtimeMs) {
        const payload = JSON.parse(readFileSync(file, 'utf8')) as { count?: number };
        cache = { mtimeMs, count: typeof payload.count === 'number' ? payload.count : 0 };
      }
      return cache.count;
    } catch {
      return 0;
    }
  };
}

const notFoundPage = join(env.distDir, '404.html');
const server = createApp({
  distDir: env.distDir,
  version: readVersion(),
  log,
  apiRateLimit: env.apiRateLimit,
  authRateLimit: env.authRateLimit,
  authFailureBudget: env.authFailureBudget,
  apiKey: env.apiKey,
  toolsCount: makeToolsCounter(env.distDir),
  dsh: env.dsh,
  dshRestart: env.dshRestart,
  news: env.news,
  // 更新接口要复用 pm2(重启)与 dsh 登录地址(等新令牌)这两组配置
  dshUpdate: {
    ...env.dshUpdate,
    pm2Bin: env.dshRestart.pm2Bin,
    appName: env.dshRestart.appName,
    pm2Home: env.dshRestart.pm2Home,
    dsh: env.dsh,
  },
  ...(existsSync(notFoundPage) ? { notFoundPage } : {}),
});

server.listen(env.port, env.host, () => {
  log.info('服务已启动', {
    url: `http://${env.host}:${env.port}/`,
    distDir: env.distDir,
    tools: makeToolsCounter(env.distDir)(),
    apiRateLimit: env.apiRateLimit,
    authRateLimit: env.authRateLimit,
    apiKeyConfigured: env.apiKey !== '',
    dshHost: env.dsh.publicHost,
    dshRestartCooldown: env.dshRestart.cooldownSeconds,
    newsProjectDir: env.news.projectDir,
    dshModuleDir: env.dshUpdate.dshModuleDir,
    logLevel: env.logLevel,
  });
});

let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('收到退出信号,开始优雅关闭', { signal });
    server.close(() => process.exit(0));
    // 兜底:5 秒内没关完就退出,避免 systemd 卡在 stopping
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
