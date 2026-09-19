/**
 * DSH 版本检测 / 更新 / 回滚接口
 * ============================================================================
 *   GET  /api/dsh/update   当前版本、各通道可用版本、更新任务进度
 *   POST /api/dsh/update   启动一次更新或回滚(后台执行,立即返回)
 *
 * ── 为什么是"后台任务 + 轮询"而不是一个同步请求 ───────────────────────────
 * 全程要做:`npm install -g @deepseek-ai/dsh@x`(几十秒)→ 重打补丁 → 重启 dsh
 * → 等新令牌(实测 dsh 启动到打印 token 约 8.6 秒)。合计远超 server/api.ts 的
 * **10 秒单请求超时**。所以 POST 只负责**启动**并立刻返回,前端轮询 GET 看进度。
 *
 * ── 风险与护栏 ──────────────────────────────────────────────────────────
 * 这是在更新一个**正在运行、且是当前会话宿主**的程序,升到坏版本会让 dsh 起不来。
 * 因此:
 *   · auth: true —— 必须带 X-Api-Key(fail-closed)
 *   · 同一时刻只允许一个任务;成功后进入冷却
 *   · 前端有二次确认;密钥每次重新输入
 *   · **升级前记住原版本**,并提供一键回滚 —— 关键在于:本工具站是**独立服务**,
 *     dsh 起不来时它照样活着,所以它是唯一还能救回来的入口(否则只能 SSH)
 *   · 命令行全部是常量 + 参数数组(execFile,不经 shell);版本号做严格白名单校验
 *
 * ── 版本判断为什么不简单 ────────────────────────────────────────────────
 * 本项目同时存在多个通道:`latest`(稳定)、`next`、`alpha`。而且**通道之间不可比大小**
 * —— 曾出现过线上装的 `0.1.6-alpha.2` 比 npm 的 `latest`(`0.1.5-rc.2`)**还新**。
 * 所以这里不做"谁大谁小"的推断,只**如实展示各通道版本**,由人来选目标。
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type {
  DshLoginUrl,
  DshUpdateJob,
  DshUpdateStartResult,
  DshUpdateStatus,
} from '../../src/shared/types.ts';
import { ApiError, type Route } from '../api.ts';
import type { Logger } from '../log.ts';
import { findLatestToken, httpValidate, type DshRouteDeps } from './dsh.ts';

/** npm 安装超时(实测几十秒,给足余量) */
const DEFAULT_INSTALL_TIMEOUT_MS = 300_000;
/** 重启后等待新令牌的上限。dsh 启动到打印 token 实测约 8.6 秒。 */
const WAIT_TOKEN_TIMEOUT_MS = 40_000;
const WAIT_TOKEN_INTERVAL_MS = 1_500;
/** registry 查询结果缓存时长:避免每次轮询都去打 npm */
const REGISTRY_TTL_MS = 10 * 60_000;
/** 版本号白名单:只允许 semver 允许的字符,杜绝把参数注入进 npm 命令 */
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

export interface DshUpdateDeps {
  /** npm 可执行文件 */
  npmBin: string;
  /** 包名(常量) */
  dshPackage: string;
  /** dsh 安装目录(读它的 package.json 拿当前版本) */
  dshModuleDir: string;
  /** loopback 补丁脚本;不存在则跳过补丁步骤 */
  patchScript: string;
  /** 传给补丁脚本的域名 */
  patchHost: string;
  /** 上一版本等状态的持久化文件 */
  stateFile: string;
  /** pm2 可执行文件 / 应用名 / 数据目录(与重启接口同一套) */
  pm2Bin: string;
  appName: string;
  pm2Home: string;
  /** 读 dsh 登录地址所需的配置(复用 dsh 路由) */
  dsh: DshRouteDeps;
  installTimeoutMs?: number;
  /** 任务成功后的冷却秒数(0 = 不限制) */
  cooldownSeconds?: number;
  /** 等新令牌的上限/间隔(测试用:缩短以免单测跑 40 秒) */
  waitTokenTimeoutMs?: number;
  waitTokenIntervalMs?: number;
  /** 可注入的执行器(测试用):argv 数组 → 结果 */
  run?: (cmd: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv)
    => Promise<{ code: number; stdout: string; stderr: string; killed?: boolean }>;
  /** 可注入的时钟(测试用) */
  now?: () => number;
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  killed?: boolean;
}

/** 默认执行器:execFile,不经 shell,参数为数组。 */
function defaultRun(
  cmd: string,
  args: string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    execFile(cmd, args, {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      ...(env !== undefined ? { env } : {}),
    }, (error, stdout, stderr) => {
      const err = error as (Error & { code?: number | string; killed?: boolean }) | null;
      resolve({
        code: err === null ? 0 : (typeof err.code === 'number' ? err.code : 1),
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        killed: err?.killed === true,
      });
    });
  });
}

const tail = (text: string, n = 400): string => text.trim().slice(-n);

export function dshUpdateRoutes(deps: DshUpdateDeps): Route[] {
  const injected = deps.run !== undefined;
  const run = deps.run ?? defaultRun;
  const now = deps.now ?? (() => Date.now());
  const installTimeout = deps.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
  const cooldownMs = Math.max(0, deps.cooldownSeconds ?? 60) * 1000;
  const waitTimeout = deps.waitTokenTimeoutMs ?? WAIT_TOKEN_TIMEOUT_MS;
  const waitInterval = deps.waitTokenIntervalMs ?? WAIT_TOKEN_INTERVAL_MS;

  /** 内存中的任务状态(单进程单实例,不落盘:重启本服务即清空) */
  let job: DshUpdateJob | null = null;
  let lastSuccessAt = 0;
  /** registry 查询缓存 */
  let registry: { at: number; channels: Record<string, string>; recent: string[] } | null = null;
  let registryError: string | null = null;

  // ---------------------------------------------------------------- 小工具

  /** 读 npm 上该包的通道与最近版本;带 TTL 缓存。 */
  async function loadRegistry(ctx: { log: Logger }): Promise<void> {
    if (registry !== null && now() - registry.at < REGISTRY_TTL_MS) return;
    try {
      const tags = await run(deps.npmBin, ['view', deps.dshPackage, 'dist-tags', '--json'], 20_000);
      const all = await run(deps.npmBin, ['view', deps.dshPackage, 'versions', '--json'], 20_000);
      if (tags.code !== 0) throw new Error(tail(tags.stderr || tags.stdout, 200));
      const parsedTags = JSON.parse(tags.stdout) as Record<string, unknown>;
      const channels: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsedTags)) {
        if (typeof v === 'string') channels[k] = v;
      }
      let recent: string[] = [];
      if (all.code === 0) {
        const parsed = JSON.parse(all.stdout) as unknown;
        if (Array.isArray(parsed)) recent = parsed.filter((v): v is string => typeof v === 'string').slice(-12).reverse();
      }
      registry = { at: now(), channels, recent };
      registryError = null;
    } catch (error) {
      // 查不到不算致命:页面照常显示当前版本,只是没有"可更新目标"
      registryError = error instanceof Error ? error.message : String(error);
      ctx.log.warn('dsh update: registry lookup failed', { error: registryError });
      registry = { at: now(), channels: {}, recent: [] };
    }
  }

  /** 已安装版本(直接读包的 package.json,比问 npm 快且准确)。 */
  function installedVersion(): string {
    try {
      const raw = JSON.parse(readFileSync(join(deps.dshModuleDir, 'package.json'), 'utf8')) as {
        version?: unknown;
      };
      return typeof raw.version === 'string' ? raw.version : '';
    } catch {
      return '';
    }
  }

  function readState(): { previousVersion?: string } {
    try {
      const raw = JSON.parse(readFileSync(deps.stateFile, 'utf8')) as { previousVersion?: unknown };
      return typeof raw.previousVersion === 'string' ? { previousVersion: raw.previousVersion } : {};
    } catch {
      return {};
    }
  }

  function writeState(previousVersion: string): void {
    try {
      mkdirSync(dirname(deps.stateFile), { recursive: true });
      writeFileSync(deps.stateFile, `${JSON.stringify({ previousVersion }, null, 2)}\n`, 'utf8');
    } catch {
      // 记不住上一版本只影响回滚,不该让更新失败
    }
  }

  /** 重启后等一个**新的**、校验通过的登录地址。失败返回 null(不算任务失败)。 */
  async function waitForNewLoginUrl(
    previousPreview: string,
    log: Logger,
  ): Promise<DshLoginUrl | null> {
    const deadline = now() + waitTimeout;
    while (now() < deadline) {
      const hit = await findLatestToken(deps.dsh.logDir, deps.dsh.logPrefix);
      const preview = hit === null ? '' : hit.token.slice(0, 8);
      if (hit !== null && preview !== previousPreview) {
        let status = 0;
        try {
          status = await httpValidate(deps.dsh.port, deps.dsh.publicHost, hit.token);
        } catch {
          status = 0;
        }
        if (status === 303) {
          log.info('dsh update: new login url ready', { tokenPrefix: preview });
          return {
            url: `https://${deps.dsh.publicHost}/?token=${hit.token}`,
            host: deps.dsh.publicHost,
            port: deps.dsh.port,
            tokenPreview: preview,
            valid: true,
            checkedAt: new Date().toISOString(),
            source: hit.source,
          };
        }
      }
      await new Promise((r) => setTimeout(r, waitInterval));
    }
    return null;
  }

  // ---------------------------------------------------------------- 任务执行

  function addStep(label: string): void {
    if (job === null) return;
    job.steps.push({ label, status: 'doing' });
  }

  function finishStep(detail: string, ok = true): void {
    if (job === null) return;
    const last = job.steps[job.steps.length - 1];
    if (last === undefined) return;
    last.status = ok ? 'done' : 'failed';
    if (detail !== '') last.detail = detail;
  }

  async function execute(target: string, action: 'update' | 'rollback', log: Logger): Promise<void> {
    if (job === null) return;
    try {
      const before = installedVersion();
      const beforeHit = await findLatestToken(deps.dsh.logDir, deps.dsh.logPrefix);
      const beforePreview = beforeHit === null ? '' : beforeHit.token.slice(0, 8);

      if (before === target) {
        finishStep(`当前已经是 ${target},无需${action === 'update' ? '更新' : '回滚'}`, false);
        job.status = 'ok';
        job.newVersion = before;
        job.finishedAt = new Date().toISOString();
        return;
      }

      // ① 安装目标版本
      addStep(`安装 ${deps.dshPackage}@${target}(npm 全局,可能要几十秒)…`);
      const install = await run(
        deps.npmBin,
        ['install', '-g', `${deps.dshPackage}@${target}`],
        installTimeout,
      );
      if (install.code !== 0) {
        finishStep(tail(install.stderr || install.stdout, 300), false);
        throw new Error(install.killed === true ? 'npm 安装超时' : `npm 安装失败(退出码 ${install.code})`);
      }
      const afterInstall = installedVersion();
      finishStep(afterInstall === target || afterInstall !== before
        ? `已安装 ${afterInstall}`
        : `安装完成(版本仍显示 ${afterInstall},请以实际为准)`);

      // ② 重打 loopback 补丁 —— npm 全局安装会整包覆盖,补丁必然丢失
      if (existsSync(deps.patchScript)) {
        addStep('重新打 loopback 补丁(升级会整体覆盖该文件)…');
        const patch = await run('/bin/bash', [deps.patchScript, deps.patchHost], 30_000);
        const ok = patch.code === 0;
        job.patchReapplied = ok;
        finishStep(ok ? '补丁已重新打上' : tail(patch.stderr || patch.stdout, 200), ok);
      } else {
        job.patchReapplied = false;
      }

      // ③ 重启 dsh
      addStep(`重启 dsh(${deps.appName})…`);
      const restart: ExecResult = await run(
        process.execPath,
        [deps.pm2Bin, 'restart', deps.appName],
        30_000,
        { ...process.env, PM2_HOME: deps.pm2Home },
      );
      if (restart.code !== 0) {
        finishStep(tail(restart.stderr || restart.stdout, 300), false);
        throw new Error('重启 dsh 失败');
      }
      finishStep('重启命令已执行');

      // ④ 等新令牌
      addStep('等待 dsh 重新启动并生成新令牌(约 10 秒)…');
      const loginUrl = await waitForNewLoginUrl(beforePreview, log);
      if (loginUrl === null) {
        finishStep('暂未取到新地址(可在「DSH 登录地址」工具再取)', false);
      } else {
        finishStep(`新令牌已就绪(${loginUrl.tokenPreview}…)`);
      }
      job.loginUrl = loginUrl;
      job.newVersion = installedVersion();

      // 只有真正换了版本才记上一版本,免得回滚目标被自己覆盖
      if (job.newVersion !== '' && job.newVersion !== before) writeState(before);

      job.status = 'ok';
      job.finishedAt = new Date().toISOString();
      lastSuccessAt = now();
      log.info('dsh update: done', { action, from: before, to: job.newVersion, target });
    } catch (error) {
      if (job !== null) {
        job.status = 'failed';
        job.finishedAt = new Date().toISOString();
        job.error = error instanceof Error ? error.message : String(error);
      }
      log.error('dsh update: failed', {
        action,
        target,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ---------------------------------------------------------------- 路由

  const statusRoute: Route = {
    method: 'GET',
    path: '/api/dsh/update',
    auth: true,
    handle: async (ctx): Promise<DshUpdateStatus> => {
      await loadRegistry(ctx);
      const state = readState();
      return {
        currentVersion: installedVersion(),
        channels: registry?.channels ?? {},
        recentVersions: registry?.recent ?? [],
        registryCheckedAt: registry !== null ? new Date(registry.at).toISOString() : null,
        registryError,
        previousVersion: state.previousVersion ?? null,
        patchAvailable: existsSync(deps.patchScript),
        job,
      };
    },
  };

  const startRoute: Route = {
    method: 'POST',
    path: '/api/dsh/update',
    auth: true,
    handle: async (ctx): Promise<DshUpdateStartResult> => {
      if (job !== null && job.status === 'running') {
        throw new ApiError(409, 'update_running', '已有更新任务在进行中,请等它结束');
      }
      if (lastSuccessAt !== 0) {
        const elapsed = now() - lastSuccessAt;
        if (elapsed < cooldownMs) {
          const retryAfter = Math.ceil((cooldownMs - elapsed) / 1000);
          throw new ApiError(429, 'update_cooldown', `刚刚更新过,请 ${retryAfter} 秒后再试`, retryAfter);
        }
      }

      const body = ctx.body;
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new ApiError(400, 'invalid_body', '请求体必须是 JSON 对象');
      }
      const record = body as Record<string, unknown>;
      const action = record['action'] === 'rollback' ? 'rollback' : 'update';

      let target = typeof record['target'] === 'string' ? record['target'].trim() : '';
      if (action === 'rollback') {
        const state = readState();
        if (state.previousVersion === undefined || state.previousVersion === '') {
          throw new ApiError(409, 'no_rollback_target', '还没有记录到上一版本,无法回滚');
        }
        target = state.previousVersion;
      }
      if (target === '') throw new ApiError(400, 'target_required', '请提供要安装的版本或通道');
      if (!VERSION_RE.test(target)) {
        // 白名单式校验:版本号只会作为 argv 的一个元素传给 npm,但仍不放行奇怪字符
        throw new ApiError(400, 'invalid_target', `版本号格式不合法:${target}`);
      }

      if (!injected && !existsSync(deps.npmBin)) {
        throw new ApiError(503, 'npm_not_found', '服务端找不到 npm(请检查 DSH_NPM_BIN 配置)');
      }

      const from = installedVersion();
      job = {
        action,
        target,
        from,
        status: 'running',
        startedAt: new Date().toISOString(),
        steps: [],
      };
      ctx.log.info('dsh update: start', { action, target, from, ip: ctx.ip });

      // 后台执行,立即返回 —— npm 安装远超接口层的 10 秒超时
      void execute(target, action, ctx.log);

      return { started: true, job };
    },
  };

  return [statusRoute, startRoute];
}
