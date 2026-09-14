/**
 * 结构化日志:每行一个 JSON,交给 journald 收集。
 *
 * 用法:
 *   const log = createLogger('info');
 *   log.info('服务器已启动', { port: 8080 });
 *
 * 约定:**不记录请求体**,也不记录完整凭据(slug/前 8 位足够排障)。
 */

import type { LogLevel } from './env.ts';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** 请求日志(字段固定,便于日志系统解析) */
  request(fields: RequestLogFields): void;
}

export interface RequestLogFields {
  id: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  ip: string;
  cfRay?: string;
  userAgent?: string;
}

export function createLogger(level: LogLevel, sink: (line: string) => void = console.log): Logger {
  const threshold = ORDER[level];

  const emit = (lvl: LogLevel, message: string, fields?: object): void => {
    if (ORDER[lvl] < threshold) return;
    sink(JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg: message, ...fields }));
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    request: (fields) => emit(fields.status >= 500 ? 'error' : 'info', 'request', fields),
  };
}
