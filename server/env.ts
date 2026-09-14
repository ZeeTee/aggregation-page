/**
 * 服务端环境变量。
 *
 * 不引入 dotenv:自己解析 `.env`(格式简单,且我们只需要 KEY=VALUE),
 * 已存在的真实环境变量优先(systemd 的 Environment= / EnvironmentFile= 也能用)。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export interface ServerEnv {
  host: string;
  port: number;
  /** 静态资源根目录(绝对路径) */
  distDir: string;
  logLevel: LogLevel;
  /** 后端接口共享密钥;空字符串表示未配置(需要密钥的接口会 fail-closed) */
  apiKey: string;
  /** 每个 IP 每分钟允许的 /api 请求数 */
  apiRateLimit: number;
}

/** 解析 .env 并注入 process.env(不覆盖已存在的变量)。返回注入的键数量。 */
export function loadEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): number {
  if (!existsSync(path)) return 0;
  let injected = 0;
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) {
      env[key] = value;
      injected += 1;
    }
  }
  return injected;
}

function pick<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** 读取服务端配置;数字字段非法时回退默认值(不因配置错误拒绝启动)。 */
export function readServerEnv(root: string, env: NodeJS.ProcessEnv = process.env): ServerEnv {
  const rawPort = Number(env['PORT'] ?? '8080');
  const rawLimit = Number(env['API_RATE_LIMIT'] ?? '60');
  return {
    host: env['HOST'] ?? '127.0.0.1',
    port: Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : 8080,
    distDir: env['DIST_DIR'] ? env['DIST_DIR'] : join(root, 'dist'),
    logLevel: pick(env['LOG_LEVEL'], LEVELS, 'info'),
    apiKey: env['TOOLBOX_API_KEY'] ?? '',
    apiRateLimit: Number.isInteger(rawLimit) && rawLimit > 0 ? rawLimit : 60,
  };
}
