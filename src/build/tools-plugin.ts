/**
 * Vite 插件：把 tools/ 目录接到前端构建里。
 *
 * 提供两个虚拟模块（构建期注入，类型见 env.d.ts）：
 *   virtual:tools  → 门户页用的工具清单（ToolMeta[]，已排除 hidden）
 *   virtual:site   → 站点文案（来自 config.json）
 *
 * 另外在写盘阶段：
 *   1. 生成 dist/tools.json（机器可读清单）
 *   2. 把 vanilla 工具目录整目录拷进 dist/tools/<slug>/（渐进迁移：只有带 main.ts 的工具才走编译）
 */

import { cpSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { Plugin } from 'vite';

import { loadBuildConfig } from './config.ts';
import { scanTools, toToolsJson } from './tools.ts';

export const VIRTUAL_TOOLS = 'virtual:tools';
export const VIRTUAL_SITE = 'virtual:site';
const RESOLVED_TOOLS = `\0${VIRTUAL_TOOLS}`;
const RESOLVED_SITE = `\0${VIRTUAL_SITE}`;

export function toolsPlugin(): Plugin {
  let root = process.cwd();
  let toolsDir = join(root, 'tools');
  let configPath = join(root, 'config.json');
  let outDir = join(root, 'dist');

  const readSite = () => loadBuildConfig(configPath);

  return {
    name: 'aggregation-page:tools',

    configResolved(config) {
      root = config.root;
      toolsDir = join(root, 'tools');
      configPath = join(root, 'config.json');
      outDir = resolve(root, config.build.outDir);
    },

    resolveId(id) {
      if (id === VIRTUAL_TOOLS) return RESOLVED_TOOLS;
      if (id === VIRTUAL_SITE) return RESOLVED_SITE;
      return null;
    },

    load(id) {
      if (id === RESOLVED_TOOLS) {
        const { visible } = scanTools(toolsDir);
        return `export const tools = ${JSON.stringify(visible, null, 2)};\n`;
      }
      if (id === RESOLVED_SITE) {
        return `export const site = ${JSON.stringify(readSite().site, null, 2)};\n`;
      }
      return null;
    },

    /** 让 dev server 监听 tool.json / 工具文件的变化，改完即时刷新 */
    configureServer(server) {
      server.watcher.add(toolsDir);
    },

    writeBundle() {
      const result = scanTools(toolsDir);
      const { site } = readSite();
      writeFileSync(
        join(outDir, 'tools.json'),
        toToolsJson(result, { title: site.title, baseUrl: site.baseUrl }),
        'utf8',
      );
      for (const tool of result.legacyTools) {
        cpSync(tool.dir, join(outDir, 'tools', tool.slug), { recursive: true });
      }
      // 迁移期兼容：vanilla 工具通过 <link href="/assets/base.css"> 引用共享样式，
      // 而 TS 工具的样式是打包后带哈希的。只要还存在 vanilla 工具，就额外输出一份
      // 稳定路径的 base.css。（全部迁移完成后可删除这段）
      if (result.legacyTools.length > 0) {
        const source = join(root, 'src', 'shared', 'base.css');
        if (existsSync(source)) {
          cpSync(source, join(outDir, 'assets', 'base.css'));
        }
      }
    },
  };
}
