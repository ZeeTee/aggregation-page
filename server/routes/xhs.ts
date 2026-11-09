/**
 * 小红书卡片接口 —— 按当日日报生成图片,再把这些图片读回来
 * ============================================================================
 *
 *   GET  /api/xhs/dates                 有哪些日期已生成卡片(公开)
 *   GET  /api/xhs/cards?date=           读某天已生成的卡片清单(公开,不生成)
 *   POST /api/xhs/cards                 重新生成卡片(🔑,有副作用 → 带冷却)
 *   GET  /api/xhs/card?date=&name=      取一张 PNG(公开)
 *
 * ── 为什么读和写分成两个接口 ────────────────────────────────────────────
 * 卡片已经并进日报流程(cron 每天 07:00 自动生成、并随 output/ 入库),
 * 所以工具站的常态是**浏览和下载**,不该每次都输密钥、也不该重复渲染。
 * 只有"想强制重做某天"才需要 POST(带密钥)。
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
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import type { XhsCardsResult, XhsCardFile } from '../../src/shared/types.ts';
import { ApiError, type Route } from '../api.ts';
import type { Logger } from '../log.ts';

/** 调用的 Python 模块(常量,不接受用户输入) */
const PY_MODULE = 'newsdaily.cli.make_cards';
/** execFile 硬超时:必须明显小于 api.ts 的 10s 单请求超时 */
const EXEC_TIMEOUT_MS = 8_000;
/** 两次生成之间的最小间隔(秒)。生成是写文件,属于副作用 */
// 幂等之后,同一天重复请求约 0.1 秒且不做实际工作,冷却不需要太长;
// 留着主要是挡住"连续换日期猛点"。
const DEFAULT_COOLDOWN_SECONDS = 3;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NAME_RE = /^card-\d{2,3}\.png$/;
const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;

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
  return { date: data.date, count: files.length, files,
           reused: (raw as { reused?: unknown }).reused === true };
}

/** 某天 xhs 目录下的卡片(按文件名排序 = 编号顺序);没有就返回空数组 */
async function readDayCards(projectDir: string, date: string): Promise<XhsCardFile[]> {
  const dir = join(projectDir, 'output', date, 'xhs');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: XhsCardFile[] = [];
  for (const name of names.filter((n) => NAME_RE.test(n)).sort()) {
    try {
      const bytes = (await readFile(join(dir, name))).byteLength;
      out.push({ name, bytes });
    } catch {
      // 单个文件读不到就跳过,不影响其它卡片
    }
  }
  return out;
}

/** 所有已有卡片的日期,新的在前 */
async function listCardDates(projectDir: string): Promise<Array<{ date: string; count: number }>> {
  let entries: string[];
  try {
    entries = await readdir(join(projectDir, 'output'));
  } catch {
    return [];
  }
  const dates = entries.filter((e) => DATE_DIR_RE.test(e)).sort().reverse();
  const out: Array<{ date: string; count: number }> = [];
  for (const date of dates) {
    const cards = await readDayCards(projectDir, date);
    if (cards.length > 0) out.push({ date, count: cards.length });
  }
  return out;
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
      const input = (body ?? {}) as { date?: unknown; force?: unknown };
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

      // force=true 才真的重渲染;否则 make_cards 会因幂等直接复用
      const force = input.force === true;
      const args = date === undefined ? [] : [`--date=${date}`];
      if (force) args.push('--force');
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

  const datesRoute: Route = {
    method: 'GET',
    path: '/api/xhs/dates',
    handle: async () => ({ dates: await listCardDates(deps.projectDir) }),
  };

  // 只读:把某天已经生成好的卡片列出来,不触发生成
  const listRoute: Route = {
    method: 'GET',
    path: '/api/xhs/cards',
    handle: async ({ query }) => {
      const date = query.get('date') ?? '';
      if (!DATE_DIR_RE.test(date)) {
        throw new ApiError(400, 'invalid_date', '日期格式应为 YYYY-MM-DD');
      }
      const files = await readDayCards(deps.projectDir, date);
      if (files.length === 0) {
        throw new ApiError(404, 'card_not_found',
          '这一天还没有卡片(日报流程每天 07:00 生成,7 天后会清理)');
      }
      return { date, count: files.length, files };
    },
  };

  return [datesRoute, listRoute, cardsRoute, cardRoute];
}
