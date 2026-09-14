/**
 * 前端调用 /api 的统一封装。
 *
 * 与后端约定一致(见 server/api.ts):成功 `{ok:true,data}`、失败 `{ok:false,error}`;
 * 这里把失败转成带 code 的 ApiError,调用方只需 catch 一次。
 */

import type { ApiResult } from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export interface CallOptions {
  method?: 'GET' | 'POST';
  /** 会被 JSON 序列化;提供了就默认用 POST */
  body?: unknown;
  /** 共享密钥,走 X-Api-Key 请求头(绝不放进 URL) */
  apiKey?: string;
  signal?: AbortSignal;
}

export async function callApi<T>(path: string, options: CallOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.apiKey !== undefined && options.apiKey !== '') headers['X-Api-Key'] = options.apiKey;

  let body: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? (body === undefined ? 'GET' : 'POST'),
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  } catch (error) {
    throw new ApiError(0, 'network_error', `网络请求失败:${(error as Error).message}`);
  }

  let payload: ApiResult<T> | undefined;
  try {
    payload = (await response.json()) as ApiResult<T>;
  } catch {
    payload = undefined;
  }
  if (payload === undefined || typeof payload !== 'object' || !('ok' in payload)) {
    throw new ApiError(response.status, 'invalid_response', `服务端返回了非预期响应(HTTP ${response.status})`);
  }
  if (!payload.ok) {
    throw new ApiError(response.status, payload.error.code, payload.error.message);
  }
  return payload.data;
}
