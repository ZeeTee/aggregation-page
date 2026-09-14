/**
 * 前端调用 /api 的统一封装
 * ============================================================================
 * 后端所有接口都返回同一个信封(定义在 server/api.ts,类型在 src/shared/types.ts):
 *
 *     成功  { ok: true,  data: {...} }
 *     失败  { ok: false, error: { code, message } }
 *
 * 这个文件只做两件事:
 *   1. 把失败信封转成带 `code` 的 ApiError,调用方 catch 一次就能按 code 给中文提示
 *      (例如 DSH 工具区分 401 密钥错 / 503 服务端没配密钥 / 429 太频繁)
 *   2. 统一处理密钥(`X-Api-Key`)与 JSON 序列化
 *
 * 约定:
 *   · 密钥**只走请求头**。放进 URL 会被 Referer、浏览器历史、服务端访问日志记录下来。
 *   · 网络异常(断网、被中断)也包成 ApiError(code='network_error'),调用方不用再判 typeof。
 */

import type { ApiResult } from './types';

/** 调用失败:带 HTTP 状态码与后端错误码,`message` 可直接展示给用户。 */
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
  /** 默认:有 body 时 POST,否则 GET */
  method?: 'GET' | 'POST';
  /** 会被 JSON 序列化;提供了就默认用 POST */
  body?: unknown;
  /** 共享密钥,走 X-Api-Key 请求头(绝不放进 URL) */
  apiKey?: string;
  /** 需要取消时传入(AbortController.signal) */
  signal?: AbortSignal;
}

/**
 * 调用接口并解包信封,直接返回 `data`。
 *
 * @throws ApiError 任何失败(网络异常 / 非 JSON 响应 / ok:false)都会抛出它
 */
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
    // 断网、DNS 失败、被 abort —— 统一成 network_error,避免调用方写 typeof error === 'object'
    throw new ApiError(0, 'network_error', `网络请求失败:${(error as Error).message}`);
  }

  // 解析信封。注意:反向代理/边缘可能返回 HTML 错误页,所以解析失败要单独处理
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
