/** 极简 DOM 助手：够用即可，不引入框架。 */

/** 查询单个元素，找不到直接抛错（比返回 null 更早暴露模板问题）。 */
export function must<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const node = root.querySelector<T>(selector);
  if (!node) throw new Error(`dom: 找不到元素 ${selector}`);
  return node;
}

/** 按标签创建元素，可带属性、类名与子节点。 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string>> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** 清空并批量追加子节点。 */
export function fill(target: Element, children: Array<Node | string>): void {
  target.replaceChildren(...children);
}

/** 防抖：用于搜索框输入。 */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms = 120) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
