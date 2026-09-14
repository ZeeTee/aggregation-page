"""渲染工具箱首页与共享样式(纯字符串拼接,不需要模板引擎)。

首页 = 顶部品牌区 + 搜索框 + 标签过滤 + 工具卡片网格。
卡片数据既渲染成 HTML,也同时输出到 ``/tools.json`` 供脚本消费。
"""

from __future__ import annotations

import html
import json

from .registry import Tool

CSS = """
:root{
  --bg:#f5f7fb;--card:#fff;--ink:#151a22;--muted:#6b7280;--line:#e6eaf0;
  --accent:#1a73e8;--accent-soft:#eaf1fe;--radius:14px;
  --shadow:0 1px 2px rgba(16,24,40,.05),0 8px 24px rgba(16,24,40,.06);
}
@media (prefers-color-scheme:dark){
  :root{--bg:#0f1319;--card:#171c25;--ink:#e8ecf3;--muted:#98a2b3;
        --accent:#6ea8fe;--accent-soft:#1b2534;--line:#252c38;
        --shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px rgba(0,0,0,.35);}
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);
  font:16px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB",
  "Microsoft YaHei","Noto Sans SC",sans-serif;}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.site-head{background:linear-gradient(135deg,#1a73e8,#0e2e7a);color:#fff;padding:26px 20px 24px}
.site-head .inner{max-width:960px;margin:0 auto}
.brand{color:#fff;font-size:22px;font-weight:700}
.brand:hover{text-decoration:none;opacity:.92}
.tagline{color:rgba(255,255,255,.8);font-size:13.5px;margin:6px 0 0}
.wrap{max-width:960px;margin:0 auto;padding:18px 16px 40px}
.toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:0 0 14px}
.search{flex:1 1 240px;min-width:200px;padding:10px 14px;border-radius:10px;
  border:1px solid var(--line);background:var(--card);color:var(--ink);font-size:15px;outline:none}
.search:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.count{color:var(--muted);font-size:13px}
.tags{display:flex;gap:7px;flex-wrap:wrap;margin:0 0 16px}
.tags button{border:1px solid var(--line);background:var(--card);color:var(--ink);
  padding:4px 11px;border-radius:999px;font-size:13px;cursor:pointer}
.tags button:hover{border-color:var(--accent)}
.tags button.on{background:var(--accent);border-color:var(--accent);color:#fff}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(230px,1fr))}
.card{display:block;background:var(--card);border:1px solid var(--line);
  border-radius:var(--radius);box-shadow:var(--shadow);padding:16px 17px;
  color:var(--ink);transition:transform .12s ease,border-color .12s ease}
.card:hover{text-decoration:none;transform:translateY(-2px);border-color:var(--accent)}
.card .icon{font-size:24px;line-height:1}
.card .name{margin:9px 0 5px;font-size:16px;font-weight:650}
.card .desc{margin:0;color:var(--muted);font-size:13.5px;min-height:2.6em}
.card .tags-line{margin:10px 0 0;font-size:12px;color:var(--muted)}
.wip{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:999px;
  background:#fff4e5;color:#b26a00;font-size:11px;vertical-align:middle}
.empty{color:var(--muted);font-size:14px;padding:8px 2px}
.site-foot{max-width:960px;margin:0 auto;padding:0 16px 40px;color:var(--muted);
  font-size:12.5px;text-align:center}
kbd{background:var(--accent-soft);border-radius:5px;padding:1px 6px;font-size:12px;
  color:var(--accent);font-family:inherit}
"""

# 首页搜索/过滤的极简前端逻辑(无依赖,直接内联)
HUB_JS = """
const q = document.getElementById('q');
const cards = [...document.querySelectorAll('.card')];
const tagBtns = [...document.querySelectorAll('.tags button')];
const countEl = document.getElementById('count');
let activeTag = '';
function apply(){
  const kw = q.value.trim().toLowerCase();
  let shown = 0;
  cards.forEach(c => {
    const okKw = !kw || c.dataset.kw.includes(kw);
    const okTag = !activeTag || c.dataset.tags.split(',').includes(activeTag);
    const ok = okKw && okTag;
    c.style.display = ok ? '' : 'none';
    if (ok) shown++;
  });
  countEl.textContent = `共 ${shown} / ${cards.length} 个工具`;
  document.getElementById('empty').style.display = shown ? 'none' : '';
}
q.addEventListener('input', apply);
tagBtns.forEach(b => b.addEventListener('click', () => {
  const t = b.dataset.tag;
  activeTag = (activeTag === t) ? '' : t;
  tagBtns.forEach(x => x.classList.toggle('on', x.dataset.tag === activeTag));
  apply();
}));
document.addEventListener('keydown', e => {
  if (e.key === '/' && document.activeElement !== q) { e.preventDefault(); q.focus(); }
});
apply();
"""


def esc(text: str) -> str:
    return html.escape(text or "", quote=True)


def _card(tool: Tool) -> str:
    wip = '<span class="wip">开发中</span>' if tool.is_wip else ""
    tags = " · ".join(tool.tags)
    return (
        f'<a class="card" href="{esc(tool.url)}" '
        f'data-kw="{esc(tool.keywords)}" data-tags="{esc(",".join(tool.tags))}">'
        f'<div class="icon">{esc(tool.icon)}</div>'
        f'<div class="name">{esc(tool.name)}{wip}</div>'
        f'<p class="desc">{esc(tool.description)}</p>'
        + (f'<p class="tags-line">{esc(tags)}</p>' if tags else "")
        + "</a>"
    )


def render_hub(tools: list[Tool], config: dict) -> str:
    site = config.get("site", {})
    all_tags: list[str] = []
    for t in tools:
        for tag in t.tags:
            if tag not in all_tags:
                all_tags.append(tag)

    cards = "".join(_card(t) for t in tools) or (
        '<p class="empty">还没有工具。在 <code>tools/</code> 下新建目录,'
        "放入 tool.json 与 index.html 即可(见 README)。</p>")
    tag_html = "".join(
        f'<button data-tag="{esc(tag)}">{esc(tag)}</button>' for tag in all_tags)
    body = f"""<div class="toolbar">
  <input id="q" class="search" type="search" placeholder="搜索工具(按 / 聚焦)…" autocomplete="off">
  <span class="count" id="count">共 {len(tools)} 个工具</span>
</div>
<div class="tags">{tag_html}</div>
<div class="grid">{cards}</div>
<p class="empty" id="empty" style="display:none">没有匹配的工具。</p>"""
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{esc(site.get('title','工具箱'))}</title>
<meta name="description" content="{esc(site.get('description',''))}">
<link rel="stylesheet" href="/assets/base.css">
</head>
<body>
<header class="site-head"><div class="inner">
  <a class="brand" href="/">{esc(site.get('title','工具箱'))}</a>
  <p class="tagline">{esc(site.get('subtitle',''))}</p>
</div></header>
<main class="wrap">
{body}
</main>
<footer class="site-foot">{esc(site.get('footer',''))}<br>
  提示:按 <kbd>/</kbd> 快速搜索</footer>
<script>{HUB_JS}</script>
</body>
</html>
"""


def render_tools_json(tools: list[Tool], config: dict) -> str:
    """输出机器可读的工具清单 /tools.json。"""
    site = config.get("site", {})
    data = {
        "site": site.get("title", ""),
        "base_url": site.get("base_url", ""),
        "count": len(tools),
        "tools": [
            {
                "slug": t.slug,
                "name": t.name,
                "description": t.description,
                "tags": t.tags,
                "icon": t.icon,
                "status": t.status,
                "url": t.url,
            }
            for t in tools
        ],
    }
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"
