"""aggregation-page:把一堆小工具汇集到一个页面上的工具箱站点。

设计要点:
  · 每个工具是 ``tools/<slug>/`` 下的一个自包含小页面(自己的 HTML/CSS/JS),
    外加一份 ``tool.json`` 元数据(名称/说明/标签/图标)。
  · 构建产物是纯静态文件,放在 ``public/``,可被任意静态服务器托管。
  · 首页由构建脚本自动生成:工具卡片 + 搜索 + 标签过滤,新增工具无需改首页。

模块划分:
  registry.py  扫描 tools/ 目录 -> Tool 列表
  render.py    Tool 列表 -> 首页 HTML / 共享样式
  site.py      构建编排:生成首页 -> 拷贝工具 -> 落盘 public/
"""

__version__ = "0.1.0"
