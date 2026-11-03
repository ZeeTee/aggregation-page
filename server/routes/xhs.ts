/**
 * 小红书卡片接口 —— 按当日日报生成图片,再把这些图片读回来
 * ============================================================================
 *
 *   POST /api/xhs/cards                 生成卡片(🔑,有副作用 → 带冷却)
 *   GET  /api/xhs/card?date=&name=      取一张 PNG(公开)
 *
 * 为什么后端是"调 Python 命令":
 * 卡片的排版逻辑(分页、折行、字号阶梯、与日报同一批选稿)全在 ai-news-daily 的
 * `newsdaily.cli.make_cards` 里。在 TS 侧重写一遍等于维护两套排版实现,必然漂移。
 * 所以这里只做两件事:execFile 调它拿 JSON、把生成的 PNG 原样读回来。
 *
 * ── 为什么 GET 图片是公开的 ──────────────────────────────────────────────
 * `<img src>` 没法带 `X-Api-Key` 请求头。这些 PNG 是公开日报内容的排版图,
 * 不含任何凭据,所以图片接口不鉴权;但**路径做了严格白名单校验**(日期必须
 * 形如 YYYY-MM-DD、文件名必须形如 card-NN.png,且解析后的绝对路径必须落在
 * 该日期的 xhs 目录内),不存在任意路径读取。
 *
 * ── 为什么是同步返回(没做后台任务)──────────────────────────────────────
 * 接口层有统一的 10 秒超时。实测生成一次 8 张约 2.8 秒(优化前 6.9 秒,贴着
 * 上限),留足余量,所以同步返回即可;execFile 自身 8 秒硬超时兜底。
 *
 * 错误码:
 *   401 unauthorized            密钥不对(server/api.ts)
 *   503 api_key_not_configured  服务端未配置密钥
 *   429 generate_cooldown       生成太频繁(带 Retry-After)
 *   400 invalid_body / invalid_date
 *   404 card_not_found
 *   502 xhs_command_failed      Python 命令失败(详情只进日志)
 *   504 timeout                 执行超时
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import type { XhsCardsResult, XhsCardFile } from '../../src/shared/types.ts';
import { ApiError, type Route } from '../api.ts';
import type { Logger } from '../log.ts';

/** 调用的 Python 模块(常量,不接受用户输入) */
const PY_MODULE = 'newsdaily.cli.make_cards';
/** execFile 硬超时:必须明显小于 api.ts 的 10s 单请求超时 */
const EXEC_TIMEOUT_MS = 8_000;
/** 两次生成之间的最小间隔(秒)。生成是写文件,属于副作用 */
const DEFAULT_COOLDOWN_SECONDS = 10;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NAME_RE = /^card-\d{2,3}\.png$/;

export interface XhsExecResult {
  code: number;
  stdout: string;
  stderr: string;
  killed?: boolean;
}

export interface XhsDeps {
  /** python3 可执行文件路径 */
  pythonBin: string;
  /** ai-news-daily 项目目录(execFile 的 cwd,也是 output/ 的根) */
  projectDir: string;
  /** 生成冷却秒数(0 = 不限制) */
  cooldownSeconds?: number;
  /** 可注入的执行器(测试用):参数为命令行参数数组 */
  run?: (args: string[]) => Promise<XhsExecResult>;
  /** 可注入的时钟(测试用) */
  now?: () => number;
}

/** 默认执行器:execFile,不经 shell,参数为数组。 */
function defaultRun(deps: XhsDeps): (args: string[]) => Promise<XhsExecResult> {
  return (args: string[]) =>
    new Promise<XhsExecResult>((resolvePromise) => {
      execFile(
        deps.pythonBin,
        ['-m', PY_MODULE, '--json', ...args],
        { cwd: deps.projectDir, timeout: EXEC_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          const err = error as (Error & { code?: number | string; killed?: boolean }) | null;
          const killed = err?.killed === true;
          const code = killed
            ? -1
            : typeof err?.code === 'number'
              ? err.code
              : err === null
                ? 0
                : -2;
          resolvePromise({ code, stdout, stderr, killed });
        },
      );
    });
}

/** 把 Python 的 JSON 输出解析成响应体;失败一律转成 502,细节只进日志。 */
function parseResult(stdout: string, log: Logger): XhsCardsResult {
  const line = stdout.trim().split('\n').filter((l) => l.trim() !== '').pop();
  if (line === undefined) {
    throw new ApiError(502, 'xhs_command_failed', '生成命令没有输出结果');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    log.warn('xhs: 无法解析生成结果', { stdout: stdout.slice(0, 400) });
    throw new ApiError(502, 'xhs_command_failed', '生成结果格式异常');
  }
  const data = raw as Partial<XhsCardsResult> & { date?: unknown; count?: unknown; files?: unknown };
  if (typeof data.date !== 'string' || !Array.isArray(data.files)) {
    throw new ApiError(502, 'xhs_command_failed', '生成结果缺少必要字段');
  }
  const files: XhsCardFile[] = [];
  for (const item of data.files) {
    const f = item as Partial<XhsCardFile>;
    if (typeof f.name === 'string' && NAME_RE.test(f.name)) {
      files.push({ name: f.name, bytes: typeof f.bytes === 'number' ? f.bytes : 0 });
    }
  }
  if (files.length === 0) {
    throw new ApiError(502, 'xhs_command_failed', '生成结果里没有可用的图片');
  }
  return { date: data.date, count: files.length, files };
}

export function xhsRoutes(deps: XhsDeps): Route[] {
  const run = deps.run ?? defaultRun(deps);
  const now = deps.now ?? (() => Date.now());
  const cooldownMs = (deps.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS) * 1000;
  let lastGeneratedAt = 0;

  const cardsRoute: Route = {
    method: 'POST',
    path: '/api/xhs/cards',
    auth: true,
    handle: async ({ body, log }) => {
      const input = (body ?? {}) as { date?: unknown };
      let date: string | undefined;
      if (input.date !== undefined && input.date !== null && input.date !== '') {
        if (typeof input.date !== 'string' || !DATE_RE.test(input.date)) {
          throw new ApiError(400, 'invalid_date', '日期格式应为 YYYY-MM-DD');
        }
        date = input.date;
      }

      if (cooldownMs > 0 && lastGeneratedAt !== 0) {
        const remain = cooldownMs - (now() - lastGeneratedAt);
        if (remain > 0) {
          throw new ApiError(429, 'generate_cooldown',
            `生成太频繁,请 ${Math.ceil(remain / 1000)} 秒后再试`,
            Math.ceil(remain / 1000));
        }
      }

      const args = date === undefined ? [] : [`--date=${date}`];
      const result = await run(args);

      if (result.killed === true) {
        throw new ApiError(504, 'timeout', '生成超时,请稍后重试');
      }
      if (result.code !== 0) {
        log.warn('xhs: 生成命令失败', {
          code: result.code,
          stderr: result.stderr.slice(0, 400),
        });
        throw new ApiError(502, 'xhs_command_failed',
          '生成失败(请确认该日期已有日报缓存)');
      }

      lastGeneratedAt = now();
      return parseResult(result.stdout, log);
    },
  };

  const cardRoute: Route = {
    method: 'GET',
    path: '/api/xhs/card',
    handle: async ({ query, res }) => {
      const date = query.get('date') ?? '';
      const name = query.get('name') ?? '';
      if (!DATE_RE.test(date) || !NAME_RE.test(name)) {
        throw new ApiError(400, 'invalid_date', '参数不合法');
      }

      const dir = resolve(join(deps.projectDir, 'output', date, 'xhs'));
      const file = resolve(join(dir, name));
      // 双保险:即便上面的正则被放宽,也不允许跳出该目录
      if (file !== join(dir, name) || !file.startsWith(dir + sep)) {
        throw new ApiError(400, 'invalid_date', '参数不合法');
      }

      let bytes: Buffer;
      try {
        bytes = await readFile(file);
      } catch {
        throw new ApiError(404, 'card_not_found', '这张卡片不存在,请重新生成');
      }

      // 直接写二进制:api.ts 只在 !res.writableEnded 时才补 JSON 信封
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': String(bytes.byteLength),
        'Cache-Control': 'public, max-age=60',
      });
      res.end(bytes);
      return undefined;
    },
  };

  return [cardsRoute, cardRoute];
}
