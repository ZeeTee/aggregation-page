/// <reference types="vite/client" />

/** 构建期由 src/build/tools-plugin.ts 注入的工具清单(类型安全) */
declare module 'virtual:tools' {
  import type { ToolMeta } from './src/shared/types';
  const tools: ToolMeta[];
  export { tools };
}

/** 构建期注入的站点文案(来自 config.json 的 site 段) */
declare module 'virtual:site' {
  import type { SiteConfig } from './src/build/config';
  const site: SiteConfig;
  export { site };
}
