"""扫描 tools/ 目录,把每个工具目录读成 Tool 对象。

工具目录结构::

    tools/时间戳转换/
    ├── tool.json      # 元数据(必需)
    └── index.html     # 工具页面(必需,自包含)

``tool.json`` 字段::

    {
      "name": "时间戳转换",          # 必需:显示名
      "description": "Unix 时间戳…",  # 可选:一句话说明
      "tags": ["时间", "开发"],       # 可选:用于首页标签过滤
      "icon": "🕒",                   # 可选:卡片图标(emoji)
      "status": "ready",              # 可选:ready | wip(开发中会显示标记)
      "order": 10                     # 可选:排序权重,越小越靠前
    }

目录名即 URL 路径 ``/tools/<slug>/``;``slug`` 取目录名,允许中文。
缺少 tool.json 或 index.html 的目录会被跳过并给出提示,不影响其它工具构建。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

ENTRY_NAME = "index.html"
META_NAME = "tool.json"
# 这些目录名不当作工具(模板、草稿等)
SKIP_PREFIXES = ("_", ".")


@dataclass
class Tool:
    slug: str                      # 目录名,即 URL 片段
    name: str
    description: str = ""
    tags: list[str] = field(default_factory=list)
    icon: str = "🧰"
    status: str = "ready"
    order: int = 100
    path: Path | None = None       # 源码目录
    mtime: float = 0.0             # 用于判断是否需要重建

    @property
    def url(self) -> str:
        return f"/tools/{self.slug}/"

    @property
    def is_wip(self) -> bool:
        return self.status.lower() in ("wip", "dev", "todo", "开发中")

    @property
    def keywords(self) -> str:
        """供首页搜索使用的关键字(名称 + 说明 + 标签)。"""
        return " ".join([self.name, self.description, *self.tags]).lower()


def _load_one(path: Path) -> Tool | None:
    meta_path = path / META_NAME
    entry = path / ENTRY_NAME
    if not meta_path.is_file():
        return None
    # 迁移期兼容:带 main.ts 的工具由 TypeScript(Vite)版本构建,
    # Python 版本无法编译 TS,直接跳过而不是产出坏页面。
    if (path / "main.ts").is_file():
        return None
    if not entry.is_file():
        print(f"    [跳过] {path.name}:缺少 {ENTRY_NAME}")
        return None
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        print(f"    [跳过] {path.name}:{META_NAME} 解析失败({exc})")
        return None
    if not isinstance(meta, dict) or not (meta.get("name") or "").strip():
        print(f"    [跳过] {path.name}:{META_NAME} 缺少 name 字段")
        return None

    tags = meta.get("tags") or []
    if isinstance(tags, str):
        tags = [tags]
    return Tool(
        slug=path.name,
        name=str(meta["name"]).strip(),
        description=str(meta.get("description", "")).strip(),
        tags=[str(t).strip() for t in tags if str(t).strip()],
        icon=str(meta.get("icon") or "🧰"),
        status=str(meta.get("status") or "ready"),
        order=int(meta.get("order", 100) or 100),
        path=path,
        mtime=max(meta_path.stat().st_mtime, entry.stat().st_mtime),
    )


def load_tools(tools_dir: str | Path, verbose: bool = True) -> list[Tool]:
    """扫描目录并返回工具列表(按 order、名称排序)。"""
    root = Path(tools_dir)
    if not root.is_dir():
        if verbose:
            print(f"    [警告] 工具目录不存在:{root}")
        return []
    tools: list[Tool] = []
    for child in sorted(root.iterdir()):
        if not child.is_dir() or child.name.startswith(SKIP_PREFIXES):
            continue
        tool = _load_one(child)
        if tool is None:
            if verbose and not (child / META_NAME).is_file():
                print(f"    [跳过] {child.name}:没有 {META_NAME}")
            continue
        tools.append(tool)
    tools.sort(key=lambda t: (t.order, t.name))
    if verbose:
        print(f"   共发现 {len(tools)} 个工具:{'、'.join(t.name for t in tools) or '无'}")
    return tools


def signature(tools_dir: str | Path,
              config_path: str | Path | None = None) -> tuple[float, int]:
    """工具目录的"指纹":(最新 mtime, 文件数量)。

    服务器靠它判断是否需要重建。**必须同时包含目录 mtime 与文件数量**:
    只比 mtime 的话,删除文件不会抬高最大值,新增/删除工具就会漏检。
    """
    latest = 0.0
    count = 0
    root = Path(tools_dir)
    if root.is_dir():
        for child in root.rglob("*"):
            try:
                latest = max(latest, child.stat().st_mtime)  # 目录 mtime 随增删变化
                if child.is_file():
                    count += 1
            except OSError:
                pass
    if config_path:
        try:
            latest = max(latest, Path(config_path).stat().st_mtime)
        except OSError:
            pass
    return (latest, count)
